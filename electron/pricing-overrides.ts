/**
 * User-configured manual pricing overrides for provider/model combinations
 * the tokenlens/models.dev catalog doesn't cover — self-hosted Ollama models
 * (no market price), custom OpenAI-compatible endpoints, or GitHub Copilot
 * (flat-subscription pricing, so tokenlens ships no per-token cost for it at
 * all) — plus a way to correct a catalog entry the user believes is stale.
 *
 * Stored in `~/.aichemist/pricing-overrides.json` (mirrors the
 * `~/.aichemist/openai-providers.json` pattern — editor-owned config, never
 * written to any SDK's own files):
 *
 * ```json
 * {
 *   "overrides": {
 *     "ollama::llama3.1": { "inputPerMTokens": 0, "outputPerMTokens": 0 },
 *     "openai-compatible::together/meta-llama/Llama-3-70b": { "inputPerMTokens": 0.9, "outputPerMTokens": 0.9 }
 *   }
 * }
 * ```
 *
 * Keys are `"<provider>::<model>"` — a literal "::" separator, not "/", since
 * `openai-compatible` model ids are themselves composite (`<endpoint>/<modelId>`)
 * and may contain slashes.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Provider } from "../src/types/index";

export interface PricingRates {
  /** USD per 1,000,000 input tokens. */
  inputPerMTokens?: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMTokens?: number;
  /** USD per 1,000,000 cache-read tokens. */
  cacheReadPerMTokens?: number;
  /** USD per 1,000,000 cache-write (creation) tokens. */
  cacheWritePerMTokens?: number;
}

export type PricingOverrideMap = Record<string, PricingRates>;

// ── Path resolution ───────────────────────────────────────────────────────────

let overridesPathOverride: string | null = null;

/** Test seam — override the config file location. Pass null to reset. */
export function _setPricingOverridesPathForTests(p: string | null): void {
  overridesPathOverride = p;
}

export function getPricingOverridesPath(): string {
  return overridesPathOverride ?? path.join(os.homedir(), ".aichemist", "pricing-overrides.json");
}

/**
 * The lookup key for a provider/model pair — "::" doesn't appear in any
 * provider id, and survives "/"-bearing composite model ids. The model is
 * trimmed here (the single normalization point shared by every read and
 * write path) so a whitespace-padded model id can never silently fail to
 * match the trimmed id `estimateCost()` looks up.
 */
export function overrideKey(provider: Provider, model: string): string {
  return `${provider}::${model.trim()}`;
}

/**
 * Validate + re-derive a key loaded from disk the same way `overrideKey()`
 * would (trimming the model half), so a hand-edited JSON file with padding
 * around a model id (e.g. `"anthropic::  my-model  "`) still matches
 * `estimateCost()`'s trimmed lookup instead of silently never matching.
 * Returns null for a key that doesn't match the documented
 * `"<provider>::<model>"` format at all — missing `"::"`, an empty provider
 * half, or an empty/whitespace-only model half — since such a key could
 * never be produced by `overrideKey()` and would otherwise sit in the map
 * silently doing nothing.
 */
function normalizeRawKey(key: string): string | null {
  const idx = key.indexOf("::");
  if (idx <= 0) return null;
  const model = key.slice(idx + 2).trim();
  if (!model) return null;
  return `${key.slice(0, idx)}::${model}`;
}

// ── Validation ────────────────────────────────────────────────────────────────

const RATE_FIELDS = ["inputPerMTokens", "outputPerMTokens", "cacheReadPerMTokens", "cacheWritePerMTokens"] as const;

/**
 * At least one rate field must be defined — an override with none would still
 * be found by `resolveRates()` (a truthy `{}`), pre-empting the catalog
 * fallback while every field silently defaults to 0, reporting a "priced"
 * turn that is actually unpriced.
 */
function isValidRates(entry: unknown): entry is PricingRates {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  let hasField = false;
  for (const key of RATE_FIELDS) {
    const value = e[key];
    if (value === undefined) continue;
    hasField = true;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  }
  return hasField;
}

// ── Read / write ──────────────────────────────────────────────────────────────

/** Best-effort read used by the write path to preserve unknown top-level keys. */
function safeReadJson(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Read and parse the config document for the public read path. A missing file
 * (ENOENT) or malformed JSON is treated as an empty config; any other I/O error
 * (e.g. EACCES / EISDIR) is rethrown.
 */
function readOverridesDoc(): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(getPricingOverridesPath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Malformed JSON — treat as empty rather than hard-failing the app.
    return {};
  }
}

/**
 * Read the configured overrides. Returns `{}` when the file is missing or its
 * JSON is malformed; rethrows real I/O errors (permission denied, etc.). Entries
 * with malformed rate fields, or a key that doesn't match `"<provider>::<model>"`
 * (see `normalizeRawKey`), are dropped (with a console warning) instead of
 * failing the whole map.
 */
export function readPricingOverrides(): PricingOverrideMap {
  const doc = readOverridesDoc();
  const raw = doc.overrides;
  if (!raw || typeof raw !== "object") return {};

  const out: PricingOverrideMap = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidRates(entry)) {
      console.warn(`[pricing-overrides] Skipping override "${key}" — rate fields must be non-negative numbers`);
      continue;
    }
    const normalizedKey = normalizeRawKey(key);
    if (!normalizedKey) {
      console.warn(`[pricing-overrides] Skipping override "${key}" — key must match "<provider>::<model>" with a non-empty model`);
      continue;
    }
    out[normalizedKey] = entry;
  }
  return out;
}

/** Replace the entire overrides map. Preserves every other key in the JSON document. */
export function writePricingOverrides(overrides: PricingOverrideMap): void {
  for (const [key, entry] of Object.entries(overrides)) {
    if (!isValidRates(entry)) {
      throw new Error(`Override "${key}" needs non-negative numeric rate fields`);
    }
  }

  const filePath = getPricingOverridesPath();
  const doc = safeReadJson(filePath);
  doc.overrides = overrides;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2) + "\n", "utf-8");
}

/** Upsert a single provider/model override. */
export function upsertPricingOverride(provider: Provider, model: string, rates: PricingRates): void {
  const current = readPricingOverrides();
  current[overrideKey(provider, model)] = rates;
  writePricingOverrides(current);
}

/** Remove a single provider/model override. No-op if it doesn't exist. */
export function deletePricingOverride(provider: Provider, model: string): void {
  const current = readPricingOverrides();
  const key = overrideKey(provider, model);
  if (!(key in current)) return;
  delete current[key];
  writePricingOverrides(current);
}
