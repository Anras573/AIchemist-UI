/**
 * User-configured spending budget — a global spend cap (reset daily, weekly,
 * or monthly) plus optional per-provider overrides. This is the config half
 * of the Spending panel (epic #155); `electron/budget-status.ts` reads it
 * alongside the usage ledger + pricing engine (`electron/usage-ledger.ts`,
 * `electron/pricing.ts`) to compute remaining balance and burn rate.
 *
 * Stored in `~/.aichemist/budget.json` (mirrors the `~/.aichemist/openai-providers.json`
 * / `~/.aichemist/pricing-overrides.json` pattern — editor-owned config, never
 * written to any SDK's own files):
 *
 * ```json
 * {
 *   "period": "monthly",
 *   "globalAmountUSD": 100,
 *   "providerAmountUSD": { "anthropic": 50 }
 * }
 * ```
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { BudgetConfig, BudgetPeriod, Provider } from "../src/types/index";
import { isProviderId, PROVIDER_IDS } from "./providers";

export type { BudgetConfig, BudgetPeriod };

const PERIODS: readonly BudgetPeriod[] = ["daily", "weekly", "monthly"];

/** Default reset period when unset — the epic's headline ask ("global monthly budget"). */
export const DEFAULT_BUDGET_PERIOD: BudgetPeriod = "monthly";

function isValidPeriod(v: unknown): v is BudgetPeriod {
  return typeof v === "string" && (PERIODS as readonly string[]).includes(v);
}

/** A finite, non-negative number. `0` is a valid *input* (it normalizes to "unset" below) — only negative/NaN/Infinity are rejected. */
function isValidAmount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * `0` and negative-or-invalid both collapse to "no budget set" (`null`) —
 * callers downstream (`computeBudgetStatus`) never have to special-case a
 * literal 0 separately from an absent budget, which is what keeps a
 * budget-of-0 from ever rendering as an alarming "-$12.34 remaining".
 */
function normalizeAmount(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

// ── Path resolution ───────────────────────────────────────────────────────────

let budgetConfigPathOverride: string | null = null;

/** Test seam — override the config file location. Pass null to reset. */
export function _setBudgetConfigPathForTests(p: string | null): void {
  budgetConfigPathOverride = p;
}

export function getBudgetConfigPath(): string {
  return budgetConfigPathOverride ?? path.join(os.homedir(), ".aichemist", "budget.json");
}

// ── Read / write ──────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read and parse the config document. A missing file (ENOENT) or malformed
 * JSON is treated as an empty document; any other I/O error (e.g. EACCES /
 * EISDIR) is rethrown so the IPC layer / Settings UI can surface a real
 * problem instead of silently reporting "no budget configured".
 */
function readDoc(): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(getBudgetConfigPath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    // Malformed JSON — treat as empty rather than hard-failing the app.
    return {};
  }
}

/** The default config — no budget set, monthly period, no provider overrides. */
export function emptyBudgetConfig(): BudgetConfig {
  return { period: DEFAULT_BUDGET_PERIOD, globalAmountUSD: null, providerAmountUSD: {} };
}

/**
 * Read the configured budget. Returns {@link emptyBudgetConfig} when the file
 * is missing or its JSON is malformed; rethrows real I/O errors. Invalid
 * entries (unrecognized period, non-numeric/negative amounts, unrecognized
 * provider keys) are dropped (with a console warning) instead of failing the
 * whole read.
 */
export function readBudgetConfig(): BudgetConfig {
  const doc = readDoc();

  let period: BudgetPeriod = DEFAULT_BUDGET_PERIOD;
  if (doc.period !== undefined) {
    if (isValidPeriod(doc.period)) {
      period = doc.period;
    } else {
      console.warn(`[budget] Ignoring invalid period "${String(doc.period)}", falling back to "${DEFAULT_BUDGET_PERIOD}"`);
    }
  }

  let globalAmountUSD: number | null = null;
  if (doc.globalAmountUSD !== undefined) {
    if (isValidAmount(doc.globalAmountUSD)) {
      globalAmountUSD = normalizeAmount(doc.globalAmountUSD);
    } else {
      console.warn(`[budget] Ignoring invalid globalAmountUSD "${String(doc.globalAmountUSD)}" — must be a non-negative number`);
    }
  }

  const providerAmountUSD: Partial<Record<Provider, number>> = {};
  if (isPlainObject(doc.providerAmountUSD)) {
    for (const [key, value] of Object.entries(doc.providerAmountUSD)) {
      if (!isProviderId(key)) {
        console.warn(`[budget] Skipping provider override "${key}" — not a recognized provider (${PROVIDER_IDS.join(", ")})`);
        continue;
      }
      if (!isValidAmount(value)) {
        console.warn(`[budget] Skipping provider override "${key}" — amount must be a non-negative number`);
        continue;
      }
      const normalized = normalizeAmount(value);
      if (normalized !== null) providerAmountUSD[key] = normalized;
    }
  }

  return { period, globalAmountUSD, providerAmountUSD };
}

/**
 * Replace the entire budget config. Every field is validated the same way
 * {@link readBudgetConfig} validates on read, but write throws on the first
 * invalid value rather than silently dropping it — a caller-facing mutation
 * should fail loudly, not persist a partially-applied config.
 */
export function writeBudgetConfig(config: BudgetConfig): void {
  if (!isValidPeriod(config.period)) {
    throw new Error(`Invalid budget period "${String(config.period)}" — must be one of ${PERIODS.join(", ")}`);
  }
  if (config.globalAmountUSD !== null && !isValidAmount(config.globalAmountUSD)) {
    throw new Error(`Invalid global budget amount "${String(config.globalAmountUSD)}" — must be a non-negative number`);
  }
  for (const [key, value] of Object.entries(config.providerAmountUSD)) {
    if (!isProviderId(key)) {
      throw new Error(`Invalid provider "${key}" in budget override — must be one of ${PROVIDER_IDS.join(", ")}`);
    }
    if (!isValidAmount(value)) {
      throw new Error(`Invalid budget amount for provider "${key}" — must be a non-negative number`);
    }
  }

  const normalized: BudgetConfig = {
    period: config.period,
    globalAmountUSD: normalizeAmount(config.globalAmountUSD),
    providerAmountUSD: {},
  };
  for (const [key, value] of Object.entries(config.providerAmountUSD)) {
    const normalizedValue = normalizeAmount(value);
    if (normalizedValue !== null) normalized.providerAmountUSD[key as Provider] = normalizedValue;
  }

  const filePath = getBudgetConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
}
