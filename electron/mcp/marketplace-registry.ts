/**
 * Live MCP registry client for the marketplace (issue #199).
 *
 * Fetches servers from the official MCP registry
 * (https://registry.modelcontextprotocol.io) and maps them onto the existing
 * `MarketplaceEntry` shape, so install/uninstall and `buildServerEntry` work
 * unchanged. Strictly opt-in (see `AICHEMIST_MCP_REGISTRY_ENABLED` in
 * settings.ts): registry entries are third-party, so the UI labels them
 * "Community" and the bundled catalog keeps "Verified".
 *
 * Fail-safe: a network error / timeout / bad payload never throws out of
 * `fetchRegistryEntries` — callers get `{ entries: [], error }` and fall back
 * to the bundled catalog. Results are cached in memory for a TTL.
 */
import type { MarketplaceConfigField, MarketplaceEntry } from "./marketplace";

export const DEFAULT_REGISTRY_URL = "https://registry.modelcontextprotocol.io";
const PAGE_LIMIT = 100;
const MAX_PAGES = 3;
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60_000;

interface RegistryArg {
  type?: string; // "positional" | "named"
  name?: string;
  value?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  description?: string;
  placeholder?: string;
  valueHint?: string;
}
interface RegistryKeyValue {
  name: string;
  value?: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  placeholder?: string;
  default?: string;
}
interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type?: string };
  packageArguments?: RegistryArg[];
  environmentVariables?: RegistryKeyValue[];
}
interface RegistryRemote {
  type?: string;
  url?: string;
  headers?: RegistryKeyValue[];
}
export interface RegistryServer {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: { url?: string };
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

let fetchImpl: typeof fetch = (...a) => fetch(...a);
/** Test seam. */
export function _setRegistryFetch(f: typeof fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a));
  _resetRegistryCache();
}

export interface RegistryResult {
  entries: MarketplaceEntry[];
  error?: string;
}
let cache: { at: number; baseUrl: string; entries: MarketplaceEntry[] } | null = null;
export function _resetRegistryCache(): void {
  cache = null;
}

/** Registry names look like `io.github.foo/bar`; make a safe mcp.json key. */
export function registryEntryId(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

const hasTemplate = (s: string | undefined) => !!s && /\{[^}]*\}/.test(s);
const fieldKey = (s: string) => s.replace(/\W/g, "_");

function mapKeyValues(
  items: RegistryKeyValue[] | undefined,
  fields: MarketplaceConfigField[],
  keyPrefix: string,
): Record<string, string> | undefined | null {
  if (!items?.length) return undefined;
  const out: Record<string, string> = {};
  for (const item of items) {
    if (!item.name) continue;
    if (item.value !== undefined && item.value !== "") {
      if (hasTemplate(item.value)) return null; // variable-substituted → unsupported
      out[item.name] = item.value;
      continue;
    }
    const key = `${keyPrefix}${fieldKey(item.name)}`;
    if (!item.isRequired && item.default === undefined && !item.isSecret) {
      // Optional, no default: leave it out rather than asking for everything.
      continue;
    }
    fields.push({
      key,
      label: item.name,
      required: !!item.isRequired,
      secret: item.isSecret || undefined,
      placeholder: item.placeholder ?? item.default,
    });
    out[item.name] = `{{${key}}}`;
  }
  return Object.keys(out).length ? out : undefined;
}

function mapPackage(pkg: RegistryPackage, base: Omit<MarketplaceEntry, "transport">): MarketplaceEntry | null {
  if (!pkg.identifier || (pkg.transport?.type ?? "stdio") !== "stdio") return null;
  let command: string;
  let args: string[];
  if (pkg.registryType === "npm") {
    command = "npx";
    args = ["-y", pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier];
  } else if (pkg.registryType === "pypi") {
    command = "uvx";
    args = [pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier];
  } else {
    return null; // oci / nuget / mcpb … not supported yet
  }
  const fields: MarketplaceConfigField[] = [];
  let i = 0;
  for (const a of pkg.packageArguments ?? []) {
    i++;
    let value = a.value;
    if (hasTemplate(value)) return null;
    if (value === undefined || value === "") {
      if (!a.isRequired) continue;
      const key = `arg_${i}`;
      fields.push({
        key,
        label: a.name ?? a.valueHint ?? a.description ?? `Argument ${i}`,
        required: true,
        secret: a.isSecret || undefined,
        placeholder: a.placeholder ?? a.valueHint,
      });
      value = `{{${key}}}`;
    }
    if (a.type === "named" && a.name) args.push(a.name, value);
    else args.push(value);
  }
  const env = mapKeyValues(pkg.environmentVariables, fields, "env_");
  if (env === null) return null;
  return {
    ...base,
    transport: "stdio",
    command,
    args,
    ...(env ? { env } : {}),
    ...(fields.length ? { configFields: fields } : {}),
  };
}

function mapRemote(remote: RegistryRemote, base: Omit<MarketplaceEntry, "transport">): MarketplaceEntry | null {
  if (!remote.url || hasTemplate(remote.url)) return null;
  const transport = remote.type === "sse" ? "sse" : remote.type === "streamable-http" ? "http" : null;
  if (!transport) return null;
  const fields: MarketplaceConfigField[] = [];
  const headers = mapKeyValues(remote.headers, fields, "header_");
  if (headers === null) return null;
  return {
    ...base,
    transport,
    url: remote.url,
    ...(headers ? { headers } : {}),
    ...(fields.length ? { configFields: fields } : {}),
  };
}

/**
 * Map one registry server onto a `MarketplaceEntry`, or `null` when nothing
 * about it is installable by us (unsupported package type, templated URL, …).
 * Prefers an npm/PyPI stdio package, then a remote.
 */
export function mapRegistryServer(server: RegistryServer): MarketplaceEntry | null {
  if (!server.name || !server.description) return null;
  const id = registryEntryId(server.name);
  if (!id) return null;
  const base: Omit<MarketplaceEntry, "transport"> = {
    id,
    name: server.title?.trim() || server.name,
    description: server.description,
    homepage: server.websiteUrl ?? server.repository?.url,
    source: "registry",
  };
  for (const pkg of server.packages ?? []) {
    const e = mapPackage(pkg, base);
    if (e) return e;
  }
  for (const remote of server.remotes ?? []) {
    const e = mapRemote(remote, base);
    if (e) return e;
  }
  return null;
}

async function fetchPage(baseUrl: string, cursor: string | undefined): Promise<{ servers: RegistryServer[]; next?: string }> {
  const url = new URL("/v0/servers", baseUrl);
  url.searchParams.set("limit", String(PAGE_LIMIT));
  url.searchParams.set("version", "latest");
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Registry responded with HTTP ${res.status}`);
  const body = (await res.json()) as {
    servers?: Array<{ server?: RegistryServer } & RegistryServer>;
    metadata?: { nextCursor?: string };
  };
  if (!Array.isArray(body.servers)) throw new Error("Unexpected registry response");
  // Current schema wraps each item as `{ server, _meta }`; older drafts were flat.
  return { servers: body.servers.map((s) => s.server ?? s), next: body.metadata?.nextCursor };
}

/** Fetch (cached, fail-safe) and map registry servers. Never throws. */
export async function fetchRegistryEntries(
  opts: { baseUrl?: string; force?: boolean } = {},
): Promise<RegistryResult> {
  const baseUrl = opts.baseUrl ?? DEFAULT_REGISTRY_URL;
  if (!opts.force && cache && cache.baseUrl === baseUrl && Date.now() - cache.at < CACHE_TTL_MS) {
    return { entries: cache.entries };
  }
  try {
    const entries: MarketplaceEntry[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { servers, next } = await fetchPage(baseUrl, cursor);
      for (const s of servers) {
        const e = mapRegistryServer(s);
        if (e && !seen.has(e.id)) {
          seen.add(e.id);
          entries.push(e);
        }
      }
      if (!next) break;
      cursor = next;
    }
    cache = { at: Date.now(), baseUrl, entries };
    return { entries };
  } catch (e) {
    // Serve stale data over nothing when a refresh fails.
    if (cache && cache.baseUrl === baseUrl) return { entries: cache.entries, error: e instanceof Error ? e.message : String(e) };
    return { entries: [], error: e instanceof Error ? e.message : String(e) };
  }
}
