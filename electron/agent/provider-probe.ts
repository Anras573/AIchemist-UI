/**
 * Provider availability probes.
 *
 * Lightweight liveness checks for the three agent providers (Anthropic,
 * Copilot, ACP) so the renderer can disable provider options that are not
 * usable on this machine (missing key, broken ACP subprocess, etc.) before
 * the user picks them.
 *
 * Mirrors the pattern in `mcp-probe.ts`:
 *   - 30 s in-process cache
 *   - `force: true` bypasses the cache
 *   - Loaders for fetch / SDK are injectable test seams
 *
 * Anthropic and Copilot probes are global (process env). The ACP probe is
 * per-project — it requires `ProjectConfig.acp_agent` and reuses
 * `getOrCreateConnection()` so the warm subprocess is shared with the real
 * session that follows.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { copilotProvider } from "./copilot";
import { acpProbe } from "./acp";
import type { AcpAgentConfig, ProjectConfig } from "../../src/types/index";
import { getApiKey } from "../config";

export interface ProviderProbeResult {
  /** True when the provider responded successfully within the timeout. */
  ok: boolean;
  /** Human-readable reason when `ok === false`. Omitted when ok. */
  reason?: string;
  /** Wall-clock duration of the probe in ms. */
  durationMs?: number;
}

export interface ProviderProbes {
  anthropic: ProviderProbeResult;
  copilot: ProviderProbeResult;
  /** Only present when a projectId / projectConfig was supplied to probeAll(). */
  acp?: ProviderProbeResult;
}

const CACHE_TTL_MS = 30_000;
const ANTHROPIC_TIMEOUT_MS = 5_000;
const COPILOT_TIMEOUT_MS = 5_000;
const ACP_TIMEOUT_MS = 3_000;

interface CacheEntry {
  result: ProviderProbeResult;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

// ── Test seams ────────────────────────────────────────────────────────────────

/** Fetch implementation, injectable for tests. */
let fetchImpl: typeof fetch = (...args) => fetch(...args);
export function _setFetch(impl: typeof fetch | null): void {
  fetchImpl = impl ?? ((...args) => fetch(...args));
}

/** Override copilot listModels (defaults to copilotProvider.listModels). */
let copilotListModels: () => Promise<Array<{ id: string; name: string }>> = async () =>
  (await copilotProvider.listModels?.()) ?? [];
export function _setCopilotListModels(
  fn: (() => Promise<Array<{ id: string; name: string }>>) | null,
): void {
  copilotListModels = fn ?? (async () => (await copilotProvider.listModels?.()) ?? []);
}

/** Override the ACP probe (defaults to `acpProbe` re-exported from acp.ts). */
let acpProbeImpl: (
  projectPath: string,
  cfg: AcpAgentConfig,
  timeoutMs: number,
) => Promise<{ ok: boolean; reason?: string }> = acpProbe;
export function _setAcpProbe(
  fn: ((projectPath: string, cfg: AcpAgentConfig, timeoutMs: number) => Promise<{ ok: boolean; reason?: string }>) | null,
): void {
  acpProbeImpl = fn ?? acpProbe;
}

export function _resetProviderProbeCache(): void {
  cache.clear();
}

// ── Generic helpers ──────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function cacheGet(key: string, force?: boolean): ProviderProbeResult | null {
  if (force) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function cacheSet(key: string, result: ProviderProbeResult): void {
  cache.set(key, { result, timestamp: Date.now() });
}

// ── Probes ────────────────────────────────────────────────────────────────────

export async function probeAnthropic(opts?: { force?: boolean }): Promise<ProviderProbeResult> {
  const cached = cacheGet("anthropic", opts?.force);
  if (cached) return cached;

  // Resolution order mirrors what the Claude SDK does:
  //   1. ANTHROPIC_API_KEY  → sent as `x-api-key`
  //   2. ANTHROPIC_AUTH_TOKEN → sent as `Authorization: Bearer …` (OAuth-style)
  //   3. Stored OAuth credential at `~/.claude/.credentials.json` (set up via `claude login`)
  // If none of those is present, the SDK has nothing to authenticate with.
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim() || null;
  const hasStoredOauth = oauthCredentialExists();

  if (!apiKey && !authToken && !hasStoredOauth) {
    const result: ProviderProbeResult = {
      ok: false,
      reason: "No Anthropic credential — set ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in ~/.aichemist/.env or run `claude login`",
    };
    cacheSet("anthropic", result);
    return result;
  }

  // OAuth credentials are stored as opaque blobs the SDK refreshes on its own.
  // We can't validate them with a simple HTTP probe, so just trust their
  // presence — the worst case is a stale token surfaces at first turn instead
  // of in the new-session UI.
  if (!apiKey && !authToken && hasStoredOauth) {
    const result: ProviderProbeResult = { ok: true };
    cacheSet("anthropic", result);
    return result;
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, "") ?? "https://api.anthropic.com";

  // Try ANTHROPIC_API_KEY first; fall back to ANTHROPIC_AUTH_TOKEN if the
  // first attempt returns 401. Some proxies (e.g., enterprise gateways) only
  // accept one or the other even when both env vars are configured.
  const attempts: Array<{ header: "x-api-key" | "Authorization"; value: string }> = [];
  if (apiKey) attempts.push({ header: "x-api-key", value: apiKey });
  if (authToken) attempts.push({ header: "Authorization", value: `Bearer ${authToken}` });

  const start = Date.now();
  let lastResult: ProviderProbeResult | null = null;
  for (const attempt of attempts) {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    headers[attempt.header] = attempt.value;
    try {
      const res = await withTimeout(
        fetchImpl(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
        }),
        ANTHROPIC_TIMEOUT_MS,
        "anthropic probe",
      );
      const durationMs = Date.now() - start;
      if (res.status === 401 || res.status === 403) {
        lastResult = {
          ok: false,
          reason: `Anthropic auth rejected (HTTP ${res.status})`,
          durationMs,
        };
        continue; // try the next auth header if any
      }
      if (res.status === 404) {
        const result: ProviderProbeResult = {
          ok: false,
          reason: `Anthropic endpoint not found at ${baseUrl}/v1/messages (HTTP 404 — check ANTHROPIC_BASE_URL)`,
          durationMs,
        };
        cacheSet("anthropic", result);
        return result;
      }
      if (res.status >= 500) {
        const result: ProviderProbeResult = {
          ok: false,
          reason: `Anthropic API returned HTTP ${res.status}`,
          durationMs,
        };
        cacheSet("anthropic", result);
        return result;
      }
      // 200, 400, 406, 429, etc. — server processed our auth. Good enough.
      const result: ProviderProbeResult = { ok: true, durationMs };
      cacheSet("anthropic", result);
      return result;
    } catch (err) {
      lastResult = {
        ok: false,
        reason: errMessage(err),
        durationMs: Date.now() - start,
      };
    }
  }
  const finalResult = lastResult ?? { ok: false, reason: "Anthropic probe failed" };
  cacheSet("anthropic", finalResult);
  return finalResult;
}

/**
 * Returns true when a Claude Code OAuth credential file is present on disk.
 * Used to recognise users who logged in via `claude login` (Pro/Max plans)
 * and so don't have an env-based API key. Defensively returns false on any
 * filesystem error.
 */
function oauthCredentialExists(): boolean {
  try {
    const credFile = path.join(os.homedir(), ".claude", ".credentials.json");
    return fs.existsSync(credFile);
  } catch {
    return false;
  }
}

export async function probeCopilot(opts?: { force?: boolean }): Promise<ProviderProbeResult> {
  const cached = cacheGet("copilot", opts?.force);
  if (cached) return cached;

  const key = getApiKey("copilot");
  if (!key) {
    const result: ProviderProbeResult = {
      ok: false,
      reason: "GITHUB_TOKEN not set in ~/.aichemist/.env",
    };
    cacheSet("copilot", result);
    return result;
  }

  const start = Date.now();
  try {
    const models = await withTimeout(copilotListModels(), COPILOT_TIMEOUT_MS, "copilot probe");
    const durationMs = Date.now() - start;
    if (!models || models.length === 0) {
      const result: ProviderProbeResult = {
        ok: false,
        reason: "Copilot SDK returned no models (token may be invalid or unauthorised)",
        durationMs,
      };
      cacheSet("copilot", result);
      return result;
    }
    const result: ProviderProbeResult = { ok: true, durationMs };
    cacheSet("copilot", result);
    return result;
  } catch (err) {
    const result: ProviderProbeResult = {
      ok: false,
      reason: errMessage(err),
      durationMs: Date.now() - start,
    };
    cacheSet("copilot", result);
    return result;
  }
}

export async function probeAcpForProject(
  projectPath: string,
  config: ProjectConfig,
  opts?: { force?: boolean },
): Promise<ProviderProbeResult> {
  const cfg = config.acp_agent;
  if (!cfg || !cfg.command) {
    return { ok: false, reason: "ACP agent not configured (set acp_agent.command in project settings)" };
  }
  // Cache key includes the agent fingerprint so config edits invalidate naturally.
  const cacheKey = `acp:${projectPath}:${fingerprintAcp(cfg)}`;
  const cached = cacheGet(cacheKey, opts?.force);
  if (cached) return cached;

  const start = Date.now();
  try {
    const probe = await acpProbeImpl(projectPath, cfg, ACP_TIMEOUT_MS);
    const durationMs = Date.now() - start;
    const result: ProviderProbeResult = { ...probe, durationMs };
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    const result: ProviderProbeResult = {
      ok: false,
      reason: errMessage(err),
      durationMs: Date.now() - start,
    };
    cacheSet(cacheKey, result);
    return result;
  }
}

/** Probe all providers in parallel; ACP is included only when `project` is supplied. */
export async function probeAll(
  project?: { path: string; config: ProjectConfig },
  opts?: { force?: boolean },
): Promise<ProviderProbes> {
  const tasks: Array<Promise<unknown>> = [
    probeAnthropic(opts),
    probeCopilot(opts),
  ];
  if (project) {
    tasks.push(probeAcpForProject(project.path, project.config, opts));
  }
  const [anthropic, copilot, acp] = await Promise.all(tasks) as [
    ProviderProbeResult,
    ProviderProbeResult,
    ProviderProbeResult | undefined,
  ];
  return project ? { anthropic, copilot, acp } : { anthropic, copilot };
}

// ── Internals ─────────────────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function fingerprintAcp(cfg: AcpAgentConfig): string {
  // Order-stable serialization of fields that affect subprocess identity.
  return JSON.stringify({
    command: cfg.command,
    args: cfg.args ?? [],
    env: cfg.env ?? {},
    cwd: cfg.cwd ?? "",
    auth_method_id: cfg.auth_method_id ?? "",
  });
}
