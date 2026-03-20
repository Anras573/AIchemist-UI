import type { McpSdkServerConfigWithInstance, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "better-sqlite3";
import type { ProjectConfig } from "../../src/types/index";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as CH from "../ipc-channels";
import { createApprovalMcpServer } from "./mcp-tools";
import { getAnthropicConfig, resolveClaudePath } from "../config";

// ── Helpers ────────────────────────────────────────────────────────────────────

function resolveModel(requestedModel: string): string {
  const {
    default_sonnet_model,
    default_haiku_model,
    default_opus_model,
  } = getAnthropicConfig();

  if (default_sonnet_model && requestedModel.includes("sonnet")) {
    return default_sonnet_model;
  }
  if (default_haiku_model && requestedModel.includes("haiku")) {
    return default_haiku_model;
  }
  if (default_opus_model && requestedModel.includes("opus")) {
    return default_opus_model;
  }
  return requestedModel;
}

/** Extract plain text from a tool_result content block (string or array). */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === "string") return c;
        const block = c as { type?: string; text?: string };
        return block.text ?? "";
      })
      .join("\n");
  }
  return String(content ?? "");
}

// ── Main export ────────────────────────────────────────────────────────────────

type AgentEntry = { name: string; description: string; model?: string };

/**
 * Parses a Claude agent markdown file's YAML frontmatter.
 * Returns null if the file does not have a valid `name` field.
 * Exported for testing.
 */
export function parseAgentFrontmatter(content: string): AgentEntry | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fm = match[1];

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");

  const descMatch = fm.match(/^description:\s*(.+)$/m);
  const description = descMatch
    ? descMatch[1].trim().replace(/^['"]|['"]$/g, "")
    : "";

  const modelMatch = fm.match(/^model:\s*(.+)$/m);
  const model = modelMatch
    ? modelMatch[1].trim().replace(/^['"]|['"]$/g, "")
    : undefined;

  return { name, description, ...(model ? { model } : {}) };
}

/** Scans ~/.claude/agents/ and returns parsed agent entries. */
function scanLocalAgents(): AgentEntry[] {
  const agentsDir = path.join(os.homedir(), ".claude", "agents");
  try {
    return fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => !e.isDirectory() && e.name.endsWith(".md"))
      .flatMap((file) => {
        try {
          const content = fs.readFileSync(
            path.join(agentsDir, file.name),
            "utf8"
          );
          const agent = parseAgentFrontmatter(content);
          return agent ? [agent] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Returns available Claude sub-agents by merging:
 * 1. Built-in agents reported by the SDK via `supportedAgents()`
 * 2. User-defined agents found in `~/.claude/agents/*.md`
 *
 * SDK agents take priority — if a local file shares a name with a built-in
 * agent, the built-in entry wins and the file is skipped.
 */
export async function getClaudeAgents(
  projectPath: string
): Promise<AgentEntry[]> {
  // 1. Built-in agents from the SDK
  let sdkAgents: AgentEntry[] = [];
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const claudePath = resolveClaudePath();
    const q = query({
      prompt: "",
      options: {
        cwd: projectPath,
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      },
    });
    try {
      sdkAgents = await q.supportedAgents();
    } finally {
      await q.return(undefined);
    }
  } catch {
    // SDK unavailable or query failed — continue with filesystem agents only
  }

  // 2. User-defined agents from ~/.claude/agents/
  const localAgents = scanLocalAgents();

  // 3. Merge, SDK agents take priority
  const sdkNames = new Set(sdkAgents.map((a) => a.name));
  return [...sdkAgents, ...localAgents.filter((a) => !sdkNames.has(a.name))];
}

export async function runClaudeAgentTurn(params: {
  db: Database;
  sessionId: string;
  sdkSessionId: string | null;
  prompt: string;
  projectPath: string;
  projectConfig: ProjectConfig;
  webContents: Electron.WebContents;
  agent?: string;
}): Promise<string> {
  const { db, sessionId, sdkSessionId, prompt, projectPath, projectConfig, webContents, agent } =
    params;

  // 1. Create the in-process MCP server (approval-gated custom tools)
  const mcpServer: McpSdkServerConfigWithInstance =
    await createApprovalMcpServer(webContents, sessionId, projectConfig);

  // 2. Resolve model ID with env-var overrides
  const model = resolveModel(projectConfig.model);

  // 3. Dynamic import — SDK is ESM-only, bundle is CJS
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // 4. Resolve claude CLI path (Electron doesn't inherit shell PATH on macOS)
  const claudePath = resolveClaudePath();

  // 5. Stream the query generator
  const queryStream: AsyncGenerator<SDKMessage, void> = query({
    prompt,
    options: {
      resume: sdkSessionId ?? undefined,
      model,
      cwd: projectPath,
      mcpServers: { "aichemist-tools": mcpServer },
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Glob", "LS"],
      includePartialMessages: true,
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      ...(agent ? { agent } : {}),
      systemPrompt:
        "You are a helpful AI assistant with access to the user's project files and tools. " +
        "Be concise and precise. When using tools, explain what you're doing before calling them.",
    },
  });

  let resultSessionId: string | null = null;
  let fullText = "";

  // Map tool_use_id → tool_name so we can label tool results
  const toolUseIdToName = new Map<string, string>();

  try {
    for await (const msg of queryStream) {
      if (msg.type === "stream_event") {
        // Extract streaming text deltas from the raw Anthropic stream event
        const event = msg.event as Record<string, unknown>;
        if (event["type"] === "content_block_delta") {
          const delta = event["delta"] as Record<string, unknown> | undefined;
          if (delta?.["type"] === "text_delta") {
            const text = delta["text"];
            if (typeof text === "string" && text.length > 0) {
              fullText += text;
              webContents.send(CH.SESSION_DELTA, {
                session_id: sessionId,
                text_delta: text,
              });
            }
          }
        }
      } else if (msg.type === "assistant") {
        // Completed assistant turn — emit tool_use blocks for native SDK tools
        // (custom MCP tools emit their own SESSION_TOOL_CALL in mcp-tools.ts)
        const content = (msg.message as { content: unknown[] }).content;
        for (const block of content) {
          const b = block as { type: string; id?: string; name?: string; input?: unknown };
          if (b.type === "tool_use" && b.name) {
            if (b.id) toolUseIdToName.set(b.id, b.name);
            webContents.send(CH.SESSION_TOOL_CALL, {
              session_id: sessionId,
              tool_name: b.name,
              input: b.input ?? {},
            });
          }
        }
      } else if (msg.type === "user") {
        // Tool results from built-in Claude Code tools (Bash, Read, etc.)
        const content = (msg as { message?: { content?: unknown[] } }).message?.content ?? [];
        for (const block of content) {
          const b = block as { type: string; tool_use_id?: string; content?: unknown };
          if (b.type === "tool_result" && b.tool_use_id) {
            const toolName = toolUseIdToName.get(b.tool_use_id) ?? "unknown";
            const output = extractToolResultText(b.content);
            webContents.send(CH.SESSION_TOOL_RESULT, {
              session_id: sessionId,
              tool_name: toolName,
              output,
            });
          }
        }
      } else if (msg.type === "result") {
        resultSessionId = msg.session_id;
      }
    }
  } catch (err) {
    throw err;
  }

  // 5. Persist sdk_session_id if it changed or was assigned for the first time
  if (resultSessionId && resultSessionId !== sdkSessionId) {
    db.prepare("UPDATE sessions SET sdk_session_id = ? WHERE id = ?").run(
      resultSessionId,
      sessionId
    );
  }

  return fullText;
}
