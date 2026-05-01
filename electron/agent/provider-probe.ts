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

import { getApiKey } from "../config";
import { copilotProvider } from "./copilot";
import { acpProbe } from "./acp";
import type { AcpAgentConfig, ProjectConfig } from "../../src/types/index";

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

  const key = getApiKey("anthropic");
  if (!key) {
    const result: ProviderProbeResult = {
      ok: false,
      reason: "ANTHROPIC_API_KEY not set in ~/.aichemist/.env",
    };
    cacheSet("anthropic", result);
    return result;
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, "") ?? "https://api.anthropic.com";
  const start = Date.now();
  try {
    const res = await withTimeout(
      fetchImpl(`${baseUrl}/v1/models`, {
        method: "GET",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
      }),
      ANTHROPIC_TIMEOUT_MS,
      "anthropic probe",
    );
    const durationMs = Date.now() - start;
    if (res.ok) {
      const result: ProviderProbeResult = { ok: true, durationMs };
      cacheSet("anthropic", result);
      return result;
    }
    if (res.status === 401 || res.status === 403) {
      const result: ProviderProbeResult = {
        ok: false,
        reason: "Invalid Anthropic API key",
        durationMs,
      };
      cacheSet("anthropic", result);
      return result;
    }
    const result: ProviderProbeResult = {
      ok: false,
      reason: `Anthropic API returned HTTP ${res.status}`,
      durationMs,
    };
    cacheSet("anthropic", result);
    return result;
  } catch (err) {
    const result: ProviderProbeResult = {
      ok: false,
      reason: errMessage(err),
      durationMs: Date.now() - start,
    };
    cacheSet("anthropic", result);
    return result;
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
