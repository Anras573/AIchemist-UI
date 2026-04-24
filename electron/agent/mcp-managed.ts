/**
 * AIchemist-managed MCP servers.
 *
 * These live in `~/.aichemist/mcp.json` and are injected into both the Claude
 * and Copilot SDK sessions at runtime — without writing into the SDKs' own
 * global config files. Mirrors VS Code's `User/mcp.json` model.
 *
 * Project-level sharing should keep using the standard `.mcp.json` at the
 * project root (Claude reads it natively, Copilot picks it up via
 * `enableConfigDiscovery`) — we deliberately don't introduce a parallel
 * project-level AIchemist file.
 */
import type { McpServerEntry, McpServersMap } from "../mcp-config";
import type { MCPServerConfig } from "@github/copilot-sdk";
import { readMcpServers } from "../mcp-config";

/**
 * Reserved name for our in-process approval-gated MCP server (see
 * electron/agent/mcp-tools.ts → createApprovalMcpServer). Managed servers must
 * not use this name or they would silently displace the built-in tools.
 */
export const RESERVED_MCP_NAME = "aichemist-tools";

/**
 * Read AIchemist-managed servers from `~/.aichemist/mcp.json`.
 * Returns an empty map if the file is missing or unreadable.
 * Filters out any entry that uses the reserved name and any name in
 * `excludeNames` (used for per-session disable).
 */
export function loadManagedMcpServers(opts?: { excludeNames?: Set<string> }): McpServersMap {
  const raw = readMcpServers("aichemist-global");
  const exclude = opts?.excludeNames;
  const out: McpServersMap = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (name === RESERVED_MCP_NAME) continue;
    if (exclude?.has(name)) continue;
    out[name] = entry;
  }
  return out;
}

// ── Adapters ─────────────────────────────────────────────────────────────────

/**
 * Convert the on-disk entry shape into what the Claude Agent SDK expects for
 * its `mcpServers` option. We pass through the raw fields verbatim — the
 * Claude SDK accepts the same `{ command, args, env, url, headers, type }`
 * shape as the on-disk file.
 *
 * Returned as a typed `Record<string, unknown>` because the SDK's published
 * type for these inline server entries is opaque and we don't want to import
 * deep internal types.
 */
export function toClaudeMcpServers(map: McpServersMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(map)) {
    if (name === RESERVED_MCP_NAME) continue;
    out[name] = { ...entry };
  }
  return out;
}

/**
 * Convert the on-disk entry shape into Copilot SDK's `MCPServerConfig` union.
 * - HTTP/SSE entries (have `url` or `type === "http"|"sse"`) → MCPRemoteServerConfig.
 * - Everything else → MCPLocalServerConfig.
 * Defaults `tools` to `["*"]` (all tools available) when unspecified, matching
 * the behaviour users get from `~/.copilot/mcp-config.json` discovery.
 */
export function toCopilotMcpServers(map: McpServersMap): Record<string, MCPServerConfig> {
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, entry] of Object.entries(map)) {
    if (name === RESERVED_MCP_NAME) continue;
    const isHttp =
      entry.type === "http" ||
      entry.type === "sse" ||
      (entry.url != null && entry.type !== "stdio" && entry.type !== "local");

    if (isHttp) {
      out[name] = {
        type: entry.type === "sse" ? "sse" : "http",
        url: entry.url ?? "",
        ...(entry.headers ? { headers: entry.headers } : {}),
        tools: extractTools(entry),
      };
    } else {
      out[name] = {
        type: "local",
        command: entry.command ?? "",
        args: Array.isArray(entry.args) ? entry.args : [],
        ...(entry.env ? { env: entry.env } : {}),
        tools: extractTools(entry),
      };
    }
  }
  return out;
}

function extractTools(entry: McpServerEntry): string[] {
  const raw = (entry as { tools?: unknown }).tools;
  if (Array.isArray(raw) && raw.every((t): t is string => typeof t === "string")) {
    return raw;
  }
  return ["*"];
}

// ── Fingerprinting ───────────────────────────────────────────────────────────

/**
 * Stable, order-independent fingerprint of a managed MCP server map. Used by
 * the Copilot runner to detect when the injected `mcpServers` map has changed
 * between turns — `resumeSession` does NOT update mcpServers on an existing
 * session, so we must force a fresh session when this fingerprint changes.
 *
 * Returns `null` for empty maps so a session created with no managed servers
 * doesn't get invalidated when the user adds the first one (and vice-versa).
 */
export function fingerprintManaged(map: McpServersMap): string | null {
  const keys = Object.keys(map)
    .filter((k) => k !== RESERVED_MCP_NAME)
    .sort();
  if (keys.length === 0) return null;
  const normalized = keys.map((k) => [k, normalizeEntry(map[k])] as const);
  return JSON.stringify(normalized);
}

function normalizeEntry(entry: McpServerEntry): unknown {
  // Sort keys recursively so cosmetic re-orderings don't churn the fingerprint.
  return sortKeys(entry);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}
