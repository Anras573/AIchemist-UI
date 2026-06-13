/**
 * User-configured OpenAI-compatible endpoints.
 *
 * Stored in `~/.aichemist/openai-providers.json` (mirrors the
 * `~/.aichemist/mcp.json` pattern — editor-owned config, never written to any
 * SDK's own files):
 *
 * ```json
 * {
 *   "endpoints": {
 *     "lmstudio": { "baseURL": "http://localhost:1234/v1" },
 *     "together": { "baseURL": "https://api.together.xyz/v1", "apiKey": "..." }
 *   }
 * }
 * ```
 *
 * Each endpoint is identified by a name that must not contain "/" — model ids
 * for the "openai-compatible" provider are composite (`<endpoint>/<modelId>`)
 * and are split on the FIRST "/", so model ids themselves may contain slashes
 * (e.g. `together/meta-llama/Llama-3-70b`).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface OpenAiEndpointEntry {
  /** Base URL including the version prefix, e.g. `http://localhost:1234/v1`. */
  baseURL: string;
  /** Optional bearer token sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Optional extra request headers. */
  headers?: Record<string, string>;
  /** Optional extra query parameters appended to every request URL. */
  queryParams?: Record<string, string>;
  /** Unknown keys are preserved on round-trip so the JSON stays user-extensible. */
  [key: string]: unknown;
}

export type OpenAiEndpointsMap = Record<string, OpenAiEndpointEntry>;

// ── Path resolution ───────────────────────────────────────────────────────────

let endpointsPathOverride: string | null = null;

/** Test seam — override the config file location. Pass null to reset. */
export function _setEndpointsPathForTests(p: string | null): void {
  endpointsPathOverride = p;
}

export function getOpenAiEndpointsPath(): string {
  return endpointsPathOverride ?? path.join(os.homedir(), ".aichemist", "openai-providers.json");
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Endpoint names become the prefix of composite model ids — no "/" allowed. */
export function isValidEndpointName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** True for a plain object whose every value is a string (e.g. headers maps). */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

/**
 * Validate the fields we later spread into request options. Unknown keys are
 * still preserved on round-trip, but a malformed `apiKey`/`headers`/`queryParams`
 * would crash model listing / client creation, so reject the whole entry — read
 * drops it, write throws.
 */
function isValidEntry(entry: unknown): entry is OpenAiEndpointEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.baseURL !== "string") return false;
  try {
    const url = new URL(e.baseURL);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  } catch {
    return false;
  }
  if (e.apiKey !== undefined && typeof e.apiKey !== "string") return false;
  if (e.headers !== undefined && !isStringRecord(e.headers)) return false;
  if (e.queryParams !== undefined && !isStringRecord(e.queryParams)) return false;
  return true;
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
 * (e.g. EACCES / EISDIR) is rethrown so the IPC layer / Settings UI can surface
 * a real problem instead of silently reporting "no endpoints configured".
 */
function readEndpointsDoc(): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(getOpenAiEndpointsPath(), "utf-8");
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
 * Read the configured endpoints. Returns `{}` when the file is missing or its
 * JSON is malformed; rethrows real I/O errors (permission denied, etc.). Entries
 * with an invalid name or malformed fields are dropped (with a console warning)
 * instead of failing the whole map.
 */
export function readOpenAiEndpoints(): OpenAiEndpointsMap {
  const doc = readEndpointsDoc();
  const raw = doc.endpoints;
  if (!raw || typeof raw !== "object") return {};

  const out: OpenAiEndpointsMap = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidEndpointName(name)) {
      console.warn(`[openai-endpoints] Skipping endpoint with invalid name "${name}" (must match [A-Za-z0-9][A-Za-z0-9._-]*)`);
      continue;
    }
    if (!isValidEntry(entry)) {
      console.warn(`[openai-endpoints] Skipping endpoint "${name}" — invalid baseURL/apiKey/headers/queryParams`);
      continue;
    }
    out[name] = entry;
  }
  return out;
}

/**
 * Replace the entire `endpoints` map. Preserves every other key in the JSON
 * document. The file may contain API keys, so it is written with mode 0600.
 */
export function writeOpenAiEndpoints(endpoints: OpenAiEndpointsMap): void {
  for (const [name, entry] of Object.entries(endpoints)) {
    if (!isValidEndpointName(name)) {
      throw new Error(`Invalid endpoint name "${name}" — use letters, digits, ".", "_" or "-" (no "/")`);
    }
    if (!isValidEntry(entry)) {
      throw new Error(`Endpoint "${name}" needs a valid http(s) baseURL and string apiKey/headers/queryParams`);
    }
  }

  const filePath = getOpenAiEndpointsPath();
  const doc = safeReadJson(filePath);
  doc.endpoints = endpoints;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  // writeFileSync only applies `mode` when creating the file — tighten
  // pre-existing files too, since this file can contain API keys.
  fs.chmodSync(filePath, 0o600);
}

/** Upsert a single named endpoint. */
export function upsertOpenAiEndpoint(name: string, entry: OpenAiEndpointEntry): void {
  const current = readOpenAiEndpoints();
  current[name] = entry;
  writeOpenAiEndpoints(current);
}

/** Remove a named endpoint. No-op if it doesn't exist. */
export function deleteOpenAiEndpoint(name: string): void {
  const current = readOpenAiEndpoints();
  if (!(name in current)) return;
  delete current[name];
  writeOpenAiEndpoints(current);
}

// ── Composite model ids ───────────────────────────────────────────────────────

/** `<endpoint>/<modelId>` — the canonical model id for openai-compatible sessions. */
export function formatCompositeModelId(endpointName: string, modelId: string): string {
  return `${endpointName}/${modelId}`;
}

/**
 * Split a composite model id on the FIRST "/" so model ids containing slashes
 * survive. Returns null when there is no "/" or either side is empty.
 */
export function parseCompositeModelId(id: string): { endpointName: string; modelId: string } | null {
  const idx = id.indexOf("/");
  if (idx <= 0 || idx === id.length - 1) return null;
  return { endpointName: id.slice(0, idx), modelId: id.slice(idx + 1) };
}
