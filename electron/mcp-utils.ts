/**
 * MCP server utilities — extracted from main.ts so they can be unit-tested.
 *
 * All functions here are pure (parseMcpListOutput, commandFingerprints) or
 * depend only on fs/os (readDotCopilotMcp, readVsCodeMcp, readCopilotMcpServers).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { McpServerInfo } from "../src/types/index";

// ── Parse `claude mcp list` stdout ───────────────────────────────────────────

/**
 * Parse the text output of `claude mcp list` into structured server entries.
 *
 * Each data line looks like one of:
 *   name: command_or_url - ✓ Connected
 *   name: command_or_url (HTTP) - ✗ Failed to connect
 */
export function parseMcpListOutput(output: string): McpServerInfo[] {
  const servers: McpServerInfo[] = [];
  const lineRe = /^(.+?):\s+(.*?)\s+-\s+([✓✗])\s+(.+)$/;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("Checking MCP")) continue;
    const m = line.match(lineRe);
    if (!m) continue;
    const [, name, rest, tick] = m;
    const transportMatch = rest.match(/\s+\(([A-Z]+)\)$/);
    const transport = transportMatch?.[1];
    const command = transportMatch ? rest.slice(0, -transportMatch[0].length).trim() : rest.trim();
    servers.push({
      name: name.trim(),
      command,
      transport,
      connected: tick === "✓",
      status: m[4].trim(),
      source: "claude",
    });
  }
  return servers;
}

// ── Fingerprinting ────────────────────────────────────────────────────────────

/**
 * Extract stable fingerprints from a server command/URL string so we can
 * match the same server across Claude and Copilot configs regardless of name.
 *
 * Rules (first match wins):
 *  - HTTP(S) URL → normalised URL (lowercase, trailing slash stripped)
 *  - npx command  → npm package name (@scope/pkg, version stripped)
 *  - uvx command  → package name (version stripped)
 *  - docker run   → image name (tag/digest stripped)
 *  - docker other → full normalised command
 *  - fallback     → full normalised command
 */
export function commandFingerprints(command: string): Set<string> {
  const fps = new Set<string>();

  const urlMatch = command.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    fps.add(urlMatch[0].replace(/\/+$/, "").toLowerCase());
    return fps;
  }

  const npxMatch = command.match(/npx\s+(?:-y\s+)?([\w@][\w@/.-]*)/);
  if (npxMatch) {
    fps.add(npxMatch[1].replace(/@[^/]+$/, "").toLowerCase());
    return fps;
  }

  const uvxMatch = command.match(/uvx\s+(?:--from\s+)?([\w@][\w@/.-]*)/);
  if (uvxMatch) {
    fps.add(uvxMatch[1].replace(/@[^/]+$/, "").toLowerCase());
    return fps;
  }

  if (command.startsWith("docker")) {
    const imgMatch = command.match(/docker\s+run\s+.*?\s+([\w./-]+(?:@sha256:[a-f0-9]+)?)\s*$/);
    if (imgMatch) {
      fps.add(imgMatch[1].replace(/[:@].*$/, "").toLowerCase());
      return fps;
    }
    fps.add(command.trim().toLowerCase());
    return fps;
  }

  fps.add(command.trim().toLowerCase());
  return fps;
}

// ── Copilot config readers ────────────────────────────────────────────────────

export type RawMcpEntry = { name: string; command: string; transport?: string };

/** Parse ~/.copilot/mcp-config.json → flat list of entries. */
export function readDotCopilotMcp(): RawMcpEntry[] {
  const cfgPath = path.join(os.homedir(), ".copilot", "mcp-config.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as {
      mcpServers?: Record<string, { type?: string; command?: string; args?: string[]; url?: string }>;
    };
    return Object.entries(parsed.mcpServers ?? {}).map(([name, cfg]) => {
      const isHttp = cfg.type === "http" || cfg.url != null;
      return {
        name,
        command: cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(" "),
        transport: isHttp ? "HTTP" : "stdio",
      };
    });
  } catch { return []; }
}

/** Parse VS Code's User/mcp.json → flat list of entries. */
export function readVsCodeMcp(overridePath?: string): RawMcpEntry[] {
  const candidates = overridePath ? [overridePath] : [
    path.join(os.homedir(), "Library", "Application Support", "Code", "User", "mcp.json"),
    path.join(os.homedir(), ".config", "Code", "User", "mcp.json"),
    path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "mcp.json"),
  ];
  for (const cfgPath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as {
        servers?: Record<string, { type?: string; command?: string; args?: string[]; url?: string }>;
      };
      const servers = parsed.servers ?? {};
      return Object.entries(servers).map(([name, cfg]) => {
        const isHttp = cfg.type === "http" || cfg.url != null;
        return {
          name,
          command: cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(" "),
          transport: isHttp ? "HTTP" : "stdio",
        };
      });
    } catch { /* try next */ }
  }
  return [];
}

/**
 * Collect all Copilot-configured MCP servers (CLI + VS Code), deduplicated
 * by fingerprint so the same server from two sources appears once.
 */
export function readCopilotMcpServers(): McpServerInfo[] {
  const all = [...readDotCopilotMcp(), ...readVsCodeMcp()];
  const seen = new Set<string>();
  const result: McpServerInfo[] = [];
  for (const entry of all) {
    const fps = commandFingerprints(entry.command);
    const key = [...fps].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name: entry.name,
      command: entry.command,
      transport: entry.transport,
      connected: null,
      status: "Configured",
      source: "copilot",
    });
  }
  return result;
}

/**
 * Read AIchemist-managed servers (~/.aichemist/mcp.json) into McpServerInfo
 * shape. These are injected per-session into both Claude and Copilot, so they
 * appear in both sessions' filtered views in the panel.
 */
export function readAichemistMcpServers(): McpServerInfo[] {
  const cfgPath = path.join(os.homedir(), ".aichemist", "mcp.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as {
      mcpServers?: Record<string, { type?: string; command?: string; args?: string[]; url?: string }>;
    };
    return Object.entries(parsed.mcpServers ?? {})
      .filter(([name]) => name !== "aichemist-tools") // reserved — see electron/agent/mcp-managed.ts
      .map(([name, cfg]) => {
      const isHttp = cfg.type === "http" || cfg.type === "sse" || cfg.url != null;
      return {
        name,
        command: cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(" "),
        transport: isHttp ? (cfg.type === "sse" ? "SSE" : "HTTP") : "stdio",
        connected: null,
        status: "Configured",
        source: "aichemist" as const,
      };
    });
  } catch { return []; }
}

/**
 * Merge Claude and Copilot server lists.
 * Claude entries whose fingerprints overlap with a Copilot server are promoted
 * to source "both". Copilot-only entries are appended at the end.
 */
export function mergeMcpServers(
  claudeServers: McpServerInfo[],
  copilotServers: McpServerInfo[],
  aichemistServers: McpServerInfo[] = [],
): McpServerInfo[] {
  const copilotFingerprints = new Set<string>();
  for (const s of copilotServers) {
    for (const fp of commandFingerprints(s.command)) copilotFingerprints.add(fp);
  }

  const merged = claudeServers.map((s) => {
    const inCopilot = [...commandFingerprints(s.command)].some((fp) => copilotFingerprints.has(fp));
    return inCopilot ? { ...s, source: "both" as const } : s;
  });

  const claudeFingerprints = new Set<string>(
    claudeServers.flatMap((s) => [...commandFingerprints(s.command)])
  );
  const copilotOnly = copilotServers.filter((s) =>
    ![...commandFingerprints(s.command)].some((fp) => claudeFingerprints.has(fp))
  );

  // AIchemist-managed servers are kept in their own bucket — they are the
  // editor's own config, not something Claude or Copilot is also configuring,
  // so we deliberately don't dedupe them against the SDK-provided lists.
  return [...merged, ...copilotOnly, ...aichemistServers];
}
