/**
 * MCP server marketplace — a bundled, curated catalog of installable servers
 * (see marketplace-catalog.ts) that the UI lists next to what's already
 * installed in the AIchemist-managed scope (`~/.aichemist/mcp.json`).
 */
import { readMcpServers } from "./config";
import { MARKETPLACE_CATALOG } from "./marketplace-catalog";

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
}

export type MarketplaceListItem = MarketplaceEntry & { installed: boolean };

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
