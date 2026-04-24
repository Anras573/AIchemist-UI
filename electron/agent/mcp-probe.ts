/**
 * Health probe for AIchemist-managed MCP servers.
 *
 * Spawns each configured server using the upstream MCP SDK's transport,
 * runs `tools/list`, and returns connection state, tool names, error message,
 * and probe duration.
 *
 * Scope is intentionally limited to AIchemist-managed servers (~/.aichemist/mcp.json).
 * Probing Claude/Copilot SDK-configured servers would duplicate behaviour those
 * SDKs perform themselves and risk inconsistency.
 *
 * Caching: a module-level cache keyed by the fingerprint of the *unfiltered*
 * managed map avoids re-probing on every panel mount. TTL is 30s. Pass
 * `force: true` to bypass the cache (used by the manual refresh button).
 *
 * Concurrency: stdio probes are capped at 4 parallel by default to avoid a
 * spawn-storm of `docker run` / `uvx` / `npx` children when the panel opens.
 */
import type { McpServerEntry, McpServersMap } from "../mcp-config";
import { fingerprintManaged, RESERVED_MCP_NAME } from "./mcp-managed";

export interface ProbeResult {
  /** True when the transport connected and `tools/list` responded successfully. */
  connected: boolean;
  /** Tool names exposed by the server. Empty if the server has no tools or the probe failed. */
  tools: string[];
  /** Error message captured during the probe (timeout, spawn failure, JSON-RPC error, …). */
  error?: string;
  /** Wall-clock duration of the probe in ms. */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STDIO_CONCURRENCY = 4;
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  fingerprint: string;
  results: Map<string, ProbeResult>;
  timestamp: number;
}

let cache: CacheEntry | null = null;

// SDK loader — extracted as an injectable so tests can swap in a stub
// without dealing with Vitest's per-import ESM mock caching.
interface SdkModules {
  Client: new (info: unknown, opts: unknown) => {
    connect(transport: unknown): Promise<void>;
    listTools(): Promise<{ tools: { name: string }[] }>;
    close(): Promise<void>;
  };
  StdioClientTransport: new (params: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr?: string;
  }) => { close: () => Promise<void> };
  StreamableHTTPClientTransport: new (url: URL) => { close: () => Promise<void> };
  SSEClientTransport: new (url: URL) => { close: () => Promise<void> };
}

let sdkLoader: () => Promise<SdkModules> = async () => {
  const [client, stdio, http, sse] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/client/sse.js"),
  ]);
  return {
    Client: client.Client as unknown as SdkModules["Client"],
    StdioClientTransport: stdio.StdioClientTransport as unknown as SdkModules["StdioClientTransport"],
    StreamableHTTPClientTransport: http.StreamableHTTPClientTransport as unknown as SdkModules["StreamableHTTPClientTransport"],
    SSEClientTransport: sse.SSEClientTransport as unknown as SdkModules["SSEClientTransport"],
  };
};

/** Test seam: replace the SDK loader. Pass `null` (or call `_resetProbeCache`) to restore the real one. */
export function _setSdkLoader(loader: (() => Promise<SdkModules>) | null): void {
  if (loader === null) {
    sdkLoader = async () => {
      const [client, stdio, http, sse] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/stdio.js"),
        import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
        import("@modelcontextprotocol/sdk/client/sse.js"),
      ]);
      return {
        Client: client.Client as unknown as SdkModules["Client"],
        StdioClientTransport: stdio.StdioClientTransport as unknown as SdkModules["StdioClientTransport"],
        StreamableHTTPClientTransport: http.StreamableHTTPClientTransport as unknown as SdkModules["StreamableHTTPClientTransport"],
        SSEClientTransport: sse.SSEClientTransport as unknown as SdkModules["SSEClientTransport"],
      };
    };
  } else {
    sdkLoader = loader;
  }
}

/**
 * Reset the in-process cache (test seam — also called by callers that mutate
 * the managed config and want the next probe to re-run immediately).
 */
export function _resetProbeCache(): void {
  cache = null;
}

/**
 * Probe every entry in the supplied managed map in parallel (with a stdio
 * concurrency cap). Returns a map keyed by server name.
 *
 * The reserved name `aichemist-tools` is filtered out before probing —
 * `loadManagedMcpServers()` already does this, but we belt-and-brace here
 * in case a caller forgets.
 */
export async function probeManagedServers(
  map: McpServersMap,
  opts?: { force?: boolean; timeoutMs?: number; stdioConcurrency?: number },
): Promise<Map<string, ProbeResult>> {
  const filtered: McpServersMap = {};
  for (const [name, entry] of Object.entries(map)) {
    if (name === RESERVED_MCP_NAME) continue;
    filtered[name] = entry;
  }

  const fp = fingerprintManaged(filtered) ?? "<empty>";
  const now = Date.now();

  if (
    !opts?.force &&
    cache !== null &&
    cache.fingerprint === fp &&
    now - cache.timestamp < CACHE_TTL_MS
  ) {
    return cache.results;
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stdioConcurrency = opts?.stdioConcurrency ?? DEFAULT_STDIO_CONCURRENCY;

  // Split entries by transport so we can apply different concurrency caps.
  const stdioEntries: [string, McpServerEntry][] = [];
  const httpEntries: [string, McpServerEntry][] = [];
  for (const [name, entry] of Object.entries(filtered)) {
    if (isHttpEntry(entry)) httpEntries.push([name, entry]);
    else stdioEntries.push([name, entry]);
  }

  const results = new Map<string, ProbeResult>();

  // HTTP probes — run all in parallel (cheap, no child processes).
  const httpPromises = httpEntries.map(async ([name, entry]) => {
    results.set(name, await probeOne(entry, timeoutMs));
  });

  // Stdio probes — capped concurrency to avoid spawn storms.
  const stdioPromise = runWithConcurrency(stdioEntries, stdioConcurrency, async ([name, entry]) => {
    results.set(name, await probeOne(entry, timeoutMs));
  });

  await Promise.all([...httpPromises, stdioPromise]);

  cache = { fingerprint: fp, results, timestamp: now };
  return results;
}

/** Treat the entry as HTTP/SSE if it has `url` or an explicit http/sse type. */
function isHttpEntry(entry: McpServerEntry): boolean {
  return (
    entry.type === "http" ||
    entry.type === "sse" ||
    (entry.url != null && entry.type !== "stdio")
  );
}

/**
 * Probe a single MCP server. Resolves with `connected: false` on any failure
 * — never throws. Always cleans up the transport, even on timeout.
 *
 * The SDK loader is injected so tests can swap in a mock without juggling
 * `vi.doMock` across multiple dynamic imports (which Vitest caches in a way
 * that's painful to invalidate per-test).
 */
async function probeOne(entry: McpServerEntry, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now();
  const sdk = await sdkLoader();

  const client = new sdk.Client(
    { name: "aichemist-probe", version: "1.0.0" },
    { capabilities: {} },
  );

  let transport: { close: () => Promise<void> } | null = null;
  let timedOut = false;

  // Timer that races against the connect+listTools sequence.
  const timer = setTimeout(() => {
    timedOut = true;
    // Best-effort transport close — kills the child on stdio.
    transport?.close().catch(() => {});
  }, timeoutMs);

  try {
    transport = await createTransport(entry, sdk);
    await client.connect(transport as never);
    if (timedOut) throw new Error(`Timed out after ${timeoutMs}ms`);

    const listed = await client.listTools();
    if (timedOut) throw new Error(`Timed out after ${timeoutMs}ms`);

    const tools = (listed.tools ?? []).map((t: { name: string }) => t.name);
    return { connected: true, tools, durationMs: Date.now() - started };
  } catch (err) {
    return {
      connected: false,
      tools: [],
      error: timedOut
        ? `Timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    try { await transport?.close(); } catch { /* already closed */ }
    try { await client.close(); } catch { /* nop */ }
  }
}

/**
 * Construct an MCP transport for the given entry. Stdio transports inherit
 * the augmented PATH from `process.env` (see electron/config.ts → augmentPath).
 */
async function createTransport(
  entry: McpServerEntry,
  sdk: SdkModules,
): Promise<{ close: () => Promise<void> }> {
  if (isHttpEntry(entry)) {
    const url = entry.url ?? "";
    if (!url) throw new Error("HTTP/SSE server config has no `url`");
    if (entry.type === "sse") {
      return new sdk.SSEClientTransport(new URL(url));
    }
    return new sdk.StreamableHTTPClientTransport(new URL(url));
  }

  if (!entry.command) throw new Error("Stdio server config has no `command`");
  // Pass the augmented PATH (loadEnv has already run by the time probes happen)
  // so npx/uvx/docker resolve the same way they do for the real SDK injections.
  const env: Record<string, string> = { ...sanitizeEnv(process.env), ...(entry.env ?? {}) };
  return new sdk.StdioClientTransport({
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args : [],
    env,
    stderr: "pipe",
  });
}

/** Drop undefined values from process.env so the type matches Record<string,string>. */
function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Run async tasks over a list with a concurrency cap. Resolves when every
 * task has settled. Caller is responsible for catching/storing per-task results
 * inside the worker function.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}
