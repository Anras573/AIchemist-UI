/**
 * MCP server config read/write across the four supported scopes.
 *
 * Scopes:
 *  - "claude-local"     → ~/.claude.json → projects[projectPath].mcpServers (requires projectPath)
 *  - "claude-project"   → <projectPath>/.mcp.json → mcpServers               (requires projectPath)
 *  - "claude-user"      → ~/.claude.json → mcpServers
 *  - "copilot-global"   → ~/.copilot/mcp-config.json → mcpServers
 *  - "aichemist-global" → ~/.aichemist/mcp.json → mcpServers
 *
 * All readers return `{}` when the file (or target key) is missing, and writers
 * preserve every other key in the underlying JSON document so we don't clobber
 * Claude Code's, Copilot's, or AIchemist's state.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type McpScope =
  | "claude-local"
  | "claude-project"
  | "claude-user"
  | "copilot-global"
  | "aichemist-global";

/**
 * Raw MCP server entry. We preserve unknown keys so users can save arbitrary
 * fields via the JSON editor without us stripping them on round-trip.
 */
export type McpServerEntry = {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
};

export type McpServersMap = Record<string, McpServerEntry>;

// ── Path resolution ───────────────────────────────────────────────────────────

export function getConfigPath(scope: McpScope, projectPath?: string): string {
  switch (scope) {
    case "claude-local":
    case "claude-user":
      return path.join(os.homedir(), ".claude.json");
    case "claude-project":
      if (!projectPath) throw new Error("projectPath is required for claude-project scope");
      return path.join(projectPath, ".mcp.json");
    case "copilot-global":
      return path.join(os.homedir(), ".copilot", "mcp-config.json");
    case "aichemist-global":
      return path.join(os.homedir(), ".aichemist", "mcp.json");
  }
}

/** Convenience wrapper for the AIchemist-managed scope. */
export function getAichemistMcpPath(): string {
  return getConfigPath("aichemist-global");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeReadJson(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function requireProject(scope: McpScope, projectPath?: string): asserts projectPath is string {
  if ((scope === "claude-local" || scope === "claude-project") && !projectPath) {
    throw new Error(`projectPath is required for scope "${scope}"`);
  }
}

// ── Readers ───────────────────────────────────────────────────────────────────

export function readMcpServers(scope: McpScope, projectPath?: string): McpServersMap {
  requireProject(scope, projectPath);
  const filePath = getConfigPath(scope, projectPath);
  const doc = safeReadJson(filePath);

  if (scope === "claude-local") {
    const projects = (doc.projects as Record<string, { mcpServers?: McpServersMap }>) ?? {};
    return projects[projectPath!]?.mcpServers ?? {};
  }

  const servers = (doc.mcpServers as McpServersMap | undefined) ?? {};
  return servers;
}

// ── Writers ───────────────────────────────────────────────────────────────────

/**
 * Replace the entire `mcpServers` map at the target scope.
 * Always preserves every other key in the underlying JSON file.
 */
export function writeMcpServers(scope: McpScope, servers: McpServersMap, projectPath?: string): void {
  requireProject(scope, projectPath);
  const filePath = getConfigPath(scope, projectPath);
  const doc = safeReadJson(filePath);

  if (scope === "claude-local") {
    const projects = (doc.projects as Record<string, Record<string, unknown>> | undefined) ?? {};
    const existing = projects[projectPath!] ?? {};
    projects[projectPath!] = { ...existing, mcpServers: servers };
    doc.projects = projects;
  } else {
    doc.mcpServers = servers;
  }

  writeJson(filePath, doc);
}

/** Convenience: upsert a single named server. */
export function upsertMcpServer(
  scope: McpScope,
  name: string,
  entry: McpServerEntry,
  projectPath?: string,
): void {
  const current = readMcpServers(scope, projectPath);
  current[name] = entry;
  writeMcpServers(scope, current, projectPath);
}

/** Convenience: remove a named server. No-op if it doesn't exist. */
export function deleteMcpServer(scope: McpScope, name: string, projectPath?: string): void {
  const current = readMcpServers(scope, projectPath);
  if (!(name in current)) return;
  delete current[name];
  writeMcpServers(scope, current, projectPath);
}
