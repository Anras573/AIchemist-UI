import * as childProcess from "child_process";
import * as CH from "../ipc-channels";
import { resolveClaudePath } from "../config";
import { parseMcpListOutput, readCopilotMcpServers, readAichemistMcpServers, mergeMcpServers } from "../mcp-utils";
import {
  loadManagedMcpServers,
  probeManagedServers,
  readMcpServers as readMcpServersConfig,
  writeMcpServers as writeMcpServersConfig,
  deleteMcpServer as deleteMcpServerConfig,
  type McpScope,
  type McpServersMap,
} from "../mcp";
import type { McpServerInfo } from "../../src/types/index";
import { handle } from "./handle";

interface ClaudeServersCache {
  timestamp: number;
  results: McpServerInfo[];
}
const claudeServersCacheByPath = new Map<string, ClaudeServersCache>();
const CLAUDE_SERVERS_CACHE_TTL_MS = 30_000;

async function getCachedClaudeServers(claudePath: string, force = false): Promise<McpServerInfo[]> {
  const now = Date.now();
  const cached = claudeServersCacheByPath.get(claudePath);

  if (!force && cached !== undefined && now - cached.timestamp < CLAUDE_SERVERS_CACHE_TTL_MS) {
    return cached.results;
  }

  const { results, ok } = await new Promise<{ results: McpServerInfo[]; ok: boolean }>((resolve) => {
    childProcess.execFile(
      claudePath,
      ["mcp", "list"],
      { encoding: "utf-8", timeout: 15_000 },
      (err, stdout) => {
        if (err) {
          resolve({ results: [], ok: false });
        } else {
          resolve({ results: parseMcpListOutput(stdout ?? ""), ok: true });
        }
      },
    );
  });

  if (ok) {
    claudeServersCacheByPath.set(claudePath, { timestamp: now, results });
  }
  return results;
}

export function registerMcpHandlers(): void {
  handle(CH.LIST_MCP_SERVERS, async () => {
    const claudePath = resolveClaudePath() ?? "claude";
    const claudeServers = await getCachedClaudeServers(claudePath);
    const copilotServers = readCopilotMcpServers();
    let aichemistServers = readAichemistMcpServers();

    if (aichemistServers.length > 0) {
      try {
        const probeResults = await probeManagedServers(loadManagedMcpServers());
        aichemistServers = aichemistServers.map((s) => {
          const r = probeResults.get(s.name);
          if (!r) return s;
          return {
            ...s,
            connected: r.connected,
            tools: r.tools,
            error: r.error,
            status: r.connected ? "Connected" : (r.error ?? "Failed to connect"),
          };
        });
      } catch (err) {
        console.error("[mcp-probe] LIST_MCP_SERVERS probe failed", err);
      }
    }

    return mergeMcpServers(claudeServers, copilotServers, aichemistServers);
  });

  handle(CH.MCP_PROBE_MANAGED, async () => {
    const claudePath = resolveClaudePath() ?? "claude";
    const claudeServers = await getCachedClaudeServers(claudePath, true);
    const copilotServers = readCopilotMcpServers();
    let aichemistServers = readAichemistMcpServers();
    if (aichemistServers.length > 0) {
      try {
        const probeResults = await probeManagedServers(loadManagedMcpServers(), { force: true });
        aichemistServers = aichemistServers.map((s) => {
          const r = probeResults.get(s.name);
          if (!r) return s;
          return {
            ...s,
            connected: r.connected,
            tools: r.tools,
            error: r.error,
            status: r.connected ? "Connected" : (r.error ?? "Failed to connect"),
          };
        });
      } catch (err) {
        console.error("[mcp-probe] MCP_PROBE_MANAGED probe failed", err);
      }
    }
    return mergeMcpServers(claudeServers, copilotServers, aichemistServers);
  });

  handle(CH.MCP_READ_CONFIG, (_event, args: { scope: McpScope; projectPath?: string }) => {
    return readMcpServersConfig(args.scope, args.projectPath);
  });
  handle(
    CH.MCP_WRITE_CONFIG,
    (_event, args: { scope: McpScope; servers: McpServersMap; projectPath?: string }) => {
      writeMcpServersConfig(args.scope, args.servers, args.projectPath);
    },
  );
  handle(
    CH.MCP_DELETE_SERVER,
    (_event, args: { scope: McpScope; name: string; projectPath?: string }) => {
      deleteMcpServerConfig(args.scope, args.name, args.projectPath);
    },
  );
}
