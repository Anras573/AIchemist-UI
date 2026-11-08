/**
 * MCP server marketplace — a bundled, curated catalog of installable servers
 * (see marketplace-catalog.ts) that the UI lists next to what's already
 * installed in the AIchemist-managed scope (`~/.aichemist/mcp.json`).
 */
import type { McpServerEntry } from "./config";
import { readMcpServers } from "./config";
import { MARKETPLACE_CATALOG } from "./marketplace-catalog";
import { fetchRegistryEntries } from "./marketplace-registry";

/** A single user-supplied value the entry's command/args/env/url/headers need before install. */
export interface MarketplaceConfigField {
  /** Token name — referenced as `{{key}}` in the entry's command/args/env/url/headers. */
  key: string;
  /** Label shown next to the input in the install form. */
  label: string;
  required: boolean;
  /** Render as a password-style input and never log the resolved value. */
  secret?: boolean;
  placeholder?: string;
}

/**
 * A catalog entry. Shape mirrors `McpServerEntry` (see config.ts) but
 * `command`/`args`/`env` values/`url`/`headers` values may contain
 * `{{token}}` placeholders resolved from `configFields` at install time.
 */
export interface MarketplaceEntry {
  /** Stable id, also used as the server name key when installed. */
  id: string;
  name: string;
  description: string;
  homepage?: string;
  tags?: string[];
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  configFields?: MarketplaceConfigField[];
  /** Where the entry came from. Absent = bundled/curated ("Verified"); "registry" = live community registry. */
  source?: "bundled" | "registry";
}

export type MarketplaceListItem = MarketplaceEntry & { installed: boolean };

export interface MarketplaceListResult {
  entries: MarketplaceListItem[];
  /** Set when the live registry was requested but could not be fetched (bundled entries are still returned). */
  registryError?: string;
}

/**
 * List every catalog entry, flagged with whether a server of the same id is
 * already present in the AIchemist-managed config (installed servers are
 * keyed by `entry.id` there).
 */
export function listMarketplaceEntries(): MarketplaceListItem[] {
  const installedNames = new Set(Object.keys(readMcpServers("aichemist-global")));
  return MARKETPLACE_CATALOG.map((entry) => ({
    ...entry,
    installed: installedNames.has(entry.id),
  }));
}

/**
 * List bundled entries plus (when `registryEnabled`) live registry entries.
 * Never throws on registry failure — falls back to the bundled catalog with
 * `registryError` set. Bundled ids win over same-id registry entries.
 */
export async function listMarketplace(opts: { registryEnabled: boolean; force?: boolean }): Promise<MarketplaceListResult> {
  const bundled = listMarketplaceEntries();
  if (!opts.registryEnabled) return { entries: bundled };
  const { entries: remote, error } = await fetchRegistryEntries({ force: opts.force });
  const bundledIds = new Set(bundled.map((e) => e.id));
  const installedNames = new Set(Object.keys(readMcpServers("aichemist-global")));
  const extra = remote
    .filter((e) => !bundledIds.has(e.id))
    .map((e) => ({ ...e, installed: installedNames.has(e.id) }));
  return { entries: [...bundled, ...extra], ...(error ? { registryError: error } : {}) };
}

/**
 * Resolve an entry by id for install: bundled first, then (when enabled) the
 * live registry. Registry entries are only ever resolved from the fetched
 * registry data, never from renderer-supplied definitions.
 */
export async function resolveMarketplaceEntry(id: string, opts: { registryEnabled: boolean }): Promise<MarketplaceEntry | undefined> {
  const bundled = getMarketplaceEntry(id);
  if (bundled || !opts.registryEnabled) return bundled;
  const { entries } = await fetchRegistryEntries();
  return entries.find((e) => e.id === id);
}

/** Look up a single bundled catalog entry by id, or `undefined` if unknown. */
export function getMarketplaceEntry(id: string): MarketplaceEntry | undefined {
  return MARKETPLACE_CATALOG.find((entry) => entry.id === id);
}

/** The entry's required `configFields` not present (or blank) in `values`. */
export function missingRequiredFields(
  entry: MarketplaceEntry,
  values: Record<string, string>,
): MarketplaceConfigField[] {
  return (entry.configFields ?? []).filter((field) => field.required && !values[field.key]?.trim());
}

/**
 * Resolve a catalog entry's `{{token}}` placeholders — in `command`, each of
 * `args`, `env`/`headers` values, and `url` — against user-supplied `values`,
 * producing a concrete `McpServerEntry` ready to write via `upsertMcpServer`.
 * A placeholder with no matching value substitutes to an empty string;
 * callers should check `missingRequiredFields` first.
 */
export function buildServerEntry(entry: MarketplaceEntry, values: Record<string, string>): McpServerEntry {
  const substitute = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? "");
  const substituteRecord = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).map(([k, v]) => [k, substitute(v)]));

  const result: McpServerEntry = { type: entry.transport };
  if (entry.command) result.command = substitute(entry.command);
  if (entry.args) result.args = entry.args.map(substitute);
  if (entry.env) result.env = substituteRecord(entry.env);
  if (entry.url) result.url = substitute(entry.url);
  if (entry.headers) result.headers = substituteRecord(entry.headers);
  return result;
}
