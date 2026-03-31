import type { McpSdkServerConfigWithInstance, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "better-sqlite3";
import type { AgentInfo, ProjectConfig } from "../../src/types/index";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createPatch } from "diff";

import * as CH from "../ipc-channels";
import * as tracer from "../tracer";
import { createApprovalMcpServer } from "./mcp-tools";
import { buildSkillsContext } from "./skills";
import { getAnthropicConfig, resolveClaudePath } from "../config";
import { requestApproval, requiresApproval } from "./approval";
import type { ToolCategory } from "./approval";
import type { AgentProvider, AgentProviderParams } from "./provider";

// ── Thinking-capable model prefixes ───────────────────────────────────────────

const THINKING_CAPABLE_MODELS = new Set([
  "claude-3-7",
  "claude-opus-4",
  "claude-sonnet-4",
  "claude-haiku-4",
]);

// ── Native tool category map ───────────────────────────────────────────────────

/** Maps a Claude Code native tool name to its approval category.
 *  Returns null for read-only or unknown tools that never require approval. */
function getNativeToolCategory(toolName: string): ToolCategory | null {
  if (["Write", "Edit", "MultiEdit", "NotebookEditCell"].includes(toolName)) return "filesystem";
  if (["Bash"].includes(toolName)) return "shell";
  if (["WebFetch", "WebSearch"].includes(toolName)) return "web";
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Returns true if a Buffer contains null bytes in its first 8 KB (binary heuristic). */
function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

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

type AgentEntry = { name: string; description: string; model?: string; path?: string; editable?: boolean };

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
          const filePath = path.join(agentsDir, file.name);
          const content = fs.readFileSync(filePath, "utf8");
          const agent = parseAgentFrontmatter(content);
          return agent ? [{ ...agent, path: filePath, editable: true }] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Reads a Claude agent file and returns its system prompt body and optional
 * model override. Returns null if the file does not exist or cannot be parsed.
 *
 * The SDK's `agent` option in `query()` does NOT load a named agent persona —
 * it is unrelated to ~/.claude/agents/*.md files. We must inject the body of
 * the agent file as `systemPrompt` ourselves.
 */
export function readAgentFileSystemPrompt(
  agentName: string
): { body: string; model?: string } | null {
  const filePath = path.join(os.homedir(), ".claude", "agents", `${agentName}.md`);
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
    if (!match) return { body: content.trim() };

    const fm = match[1];
    const body = (match[2] ?? "").trim();
    const modelMatch = fm.match(/^model:\s*(.+)$/m);
    const agentModel = modelMatch
      ? modelMatch[1].trim().replace(/^['"]|['"]$/g, "")
      : undefined;
    return { body, model: agentModel };
  } catch {
    return null;
  }
}

/**
 * Returns available Claude sub-agents by merging:
 * 1. Built-in agents reported by the SDK via `supportedAgents()`
 * 2. User-defined agents found in `~/.claude/agents/*.md`
 *
 * SDK agents take priority for display metadata (description, model), but
 * if a local file exists for an SDK agent, it is marked editable so users
 * can edit or delete it. SDK-only agents (no local file) are read-only.
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
        settingSources: ["local", "user", "project"],
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      },
    });
    try {
      sdkAgents = (await q.supportedAgents()).map((a) => ({ ...a, editable: false }));
    } finally {
      await q.return(undefined);
    }
  } catch {
    // SDK unavailable or query failed — continue with filesystem agents only
  }

  // 2. User-defined agents from ~/.claude/agents/
  const localAgents = scanLocalAgents();
  const localFileMap = new Map(localAgents.map((a) => [a.name, a]));

  // 3. Merge: SDK metadata takes priority, but local files determine editability.
  //    If the SDK reports an agent that also has a local file, mark it editable.
  const sdkNames = new Set(sdkAgents.map((a) => a.name));
  const mergedSdkAgents = sdkAgents.map((a) => {
    const local = localFileMap.get(a.name);
    return local ? { ...a, path: local.path, editable: true } : a;
  });

  return [
    ...mergedSdkAgents,
    ...localAgents.filter((a) => !sdkNames.has(a.name)),
  ];
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
  skills?: string[];
}): Promise<string> {
  const { db, sessionId, sdkSessionId, prompt, projectPath, projectConfig, webContents, agent, skills } =
    params;

  // 1. Create the in-process MCP server (approval-gated custom tools)
  const mcpServer: McpSdkServerConfigWithInstance =
    await createApprovalMcpServer(webContents, sessionId, projectConfig, projectPath);

  // 2. Resolve model — agent file can override the project model
  let effectiveModel = resolveModel(projectConfig.model);

  // 3. Dynamic import — SDK is ESM-only, bundle is CJS
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // 4. Resolve claude CLI path (Electron doesn't inherit shell PATH on macOS)
  const claudePath = resolveClaudePath();

  // 5. Determine system prompt:
  //    - Named agent selected → read its .md file body as system prompt.
  //      The SDK's `agent` option does NOT load user-defined agent files;
  //      we must inject the file body as systemPrompt ourselves.
  //    - No agent → use the default assistant prompt.
  //    In both cases, active skills context is appended.
  const skillsContext = buildSkillsContext(skills ?? [], projectPath);
  let systemPrompt: string;
  let sdkAgent: string | undefined;

  if (agent) {
    const agentFile = readAgentFileSystemPrompt(agent);
    if (agentFile) {
      // File-based agent: use its body as the system prompt
      systemPrompt = agentFile.body + skillsContext;
      if (agentFile.model) effectiveModel = resolveModel(agentFile.model);
    } else {
      // SDK built-in agent (no local file): delegate to the SDK
      sdkAgent = agent;
      systemPrompt =
        "You are a helpful AI assistant with access to the user's project files and tools. " +
        "Be concise and precise. When using tools, explain what you're doing before calling them." +
        skillsContext;
    }
  } else {
    systemPrompt =
      "You are a helpful AI assistant with access to the user's project files and tools. " +
      "Be concise and precise. When using tools, explain what you're doing before calling them." +
      skillsContext;
  }

  // 6. Stream the query generator
  const isThinkingCapable = [...THINKING_CAPABLE_MODELS].some((m) => effectiveModel.includes(m));

  const queryStream: AsyncGenerator<SDKMessage, void> = query({
    prompt,
    options: {
      resume: sdkSessionId ?? undefined,
      model: effectiveModel,
      cwd: projectPath,
      mcpServers: { "aichemist-tools": mcpServer },
      settingSources: ["local", "user", "project"],
      permissionMode: "acceptEdits",
      // ⚠️  SDK naming trap:
      //   allowedTools = "auto-approve these without a permission prompt" (does NOT restrict availability)
      //   tools        = "restrict to ONLY these built-in tools" (also blocks our MCP tools — don't use)
      // We use allowedTools to suppress interactive prompts for safe native tools (Read, Glob, etc.)
      // while letting the model still access all MCP tools from our custom server.
      // File changes from native Write/Edit are tracked via the tool_use intercept below.
      allowedTools: ["Read", "Glob", "LS", "Skill", "Agent"],
      includePartialMessages: true,
      systemPrompt,
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      ...(sdkAgent ? { agent: sdkAgent } : {}),
      ...(isThinkingCapable ? { thinking: { type: "enabled" as const, budgetTokens: 8000 } } : {}),
      // ── Pre-tool hook: approval gate for native Claude Code tools ──────────
      // MCP tools (write_file, delete_file, execute_bash, web_fetch) handle
      // approval inside mcp-tools.ts. This hook covers native SDK tools that
      // bypass the MCP server (Write, Edit, Bash, WebFetch, etc.).
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input: unknown) => {
                const { tool_name, tool_input } = input as { tool_name: string; tool_input: unknown };
                // MCP tools use their own approval gate — skip
                if (tool_name.startsWith("mcp__")) {
                  return { decision: "approve" as const };
                }
                const category = getNativeToolCategory(tool_name);
                if (!category) return { decision: "approve" as const };
                if (!requiresApproval(sessionId, projectConfig, category, tool_name, tool_input)) {
                  return { decision: "approve" as const };
                }
                const approved = await requestApproval(webContents, sessionId, tool_name, tool_input);
                return approved
                  ? { decision: "approve" as const }
                  : { decision: "block" as const, reason: "Denied by user." };
              },
            ],
          },
        ],
      },
    },
  });

  let resultSessionId: string | null = null;
  let fullText = "";
  let inThinkingBlock = false;

  // Map tool_use_id → tool_name/spanId so we can label results and end spans
  const toolUseIdToName = new Map<string, string>();
  const toolUseIdToSpanId = new Map<string, string>();
  // Map tool_use_id → { filePath, beforeContent } for native Write/Edit tracking
  const pendingFileChanges = new Map<string, { filePath: string; before: Buffer | null }>();

  // ── Tracing: start turn span and relay updates to the renderer ───────────────
  const turnStartMs = Date.now();
  const turnSpanId = tracer.startSpan({
    sessionId,
    type: "turn",
    name: agent ? `Agent: ${agent}` : "Agent Turn",
    startMs: turnStartMs,
  });
  let firstTokenMs: number | null = null;
  const unsubTracer = tracer.onSpanUpdate((span) => webContents.send(CH.SESSION_TRACE, span));

  try {
    for await (const msg of queryStream) {
      if (msg.type === "stream_event") {
        // Extract streaming text deltas from the raw Anthropic stream event
        const event = msg.event as Record<string, unknown>;
        if (event["type"] === "content_block_start") {
          const contentBlock = event["content_block"] as Record<string, unknown> | undefined;
          if (contentBlock?.["type"] === "thinking") {
            inThinkingBlock = true;
          }
        } else if (event["type"] === "content_block_delta") {
          const delta = event["delta"] as Record<string, unknown> | undefined;
          if (delta?.["type"] === "text_delta") {
            const text = delta["text"];
            if (typeof text === "string" && text.length > 0) {
              if (!firstTokenMs) firstTokenMs = Date.now();
              fullText += text;
              webContents.send(CH.SESSION_DELTA, {
                session_id: sessionId,
                text_delta: text,
              });
            }
          } else if (delta?.["type"] === "thinking_delta") {
            const thinkingText = delta["thinking"];
            if (typeof thinkingText === "string" && thinkingText.length > 0) {
              webContents.send(CH.SESSION_THINKING_DELTA, {
                session_id: sessionId,
                text_delta: thinkingText,
              });
            }
          }
        } else if (event["type"] === "content_block_stop") {
          if (inThinkingBlock) {
            inThinkingBlock = false;
            webContents.send(CH.SESSION_THINKING_DONE, {
              session_id: sessionId,
            });
          }
        }
      } else if (msg.type === "assistant") {
        // Completed assistant turn — emit tool_use blocks for native SDK tools.
        // MCP tools (mcp__aichemist-tools__*) handle their own SESSION_TOOL_CALL
        // in mcp-tools.ts, so we skip the push event here to avoid duplicates.
        const content = (msg.message as { content: unknown[] }).content;
        for (const block of content) {
          const b = block as { type: string; id?: string; name?: string; input?: unknown };
          if (b.type === "tool_use" && b.name) {
            const isMcp = b.name.startsWith("mcp__");
            // Strip "mcp__aichemist-tools__" prefix for display / tracing
            const displayName = isMcp
              ? b.name.replace(/^mcp__[^_]+__/, "")
              : b.name;
            if (b.id) {
              toolUseIdToName.set(b.id, displayName);
              const toolSpanId = tracer.startSpan({
                sessionId,
                type: "tool",
                name: displayName,
                parentId: turnSpanId,
                startMs: Date.now(),
                meta: { input: b.input ?? {} },
              });
              toolUseIdToSpanId.set(b.id, toolSpanId);

              // Capture before-content for native file write/edit tools
              const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEditCell"]);
              if (!isMcp && FILE_WRITE_TOOLS.has(b.name) && b.id) {
                const inp = b.input as Record<string, unknown> | undefined;
                const filePath = (inp?.["file_path"] ?? inp?.["notebook_path"]) as string | undefined;
                if (filePath) {
                  let before: Buffer | null = null;
                  try { before = fs.readFileSync(filePath); } catch { /* new file */ }
                  pendingFileChanges.set(b.id, { filePath, before });
                }
              }
            }
            // MCP tools emit SESSION_TOOL_CALL themselves; skip for native tools only
            if (!isMcp) {
              webContents.send(CH.SESSION_TOOL_CALL, {
                session_id: sessionId,
                tool_name: displayName,
                input: b.input ?? {},
              });
            }
          }
        }
      } else if (msg.type === "user") {
        // Tool results from built-in Claude Code tools (Bash, Read, etc.)
        const content = (msg as { message?: { content?: unknown[] } }).message?.content ?? [];
        for (const block of content) {
          const b = block as { type: string; tool_use_id?: string; content?: unknown };
          if (b.type === "tool_result" && b.tool_use_id) {
            const toolName = toolUseIdToName.get(b.tool_use_id) ?? "unknown";
            const spanId = toolUseIdToSpanId.get(b.tool_use_id);
            if (spanId) tracer.endSpan(spanId, "success");
            const output = extractToolResultText(b.content);
            webContents.send(CH.SESSION_TOOL_RESULT, {
              session_id: sessionId,
              tool_name: toolName,
              output,
            });

            // Emit file change event for native write/edit tools
            const pending = pendingFileChanges.get(b.tool_use_id);
            if (pending) {
              pendingFileChanges.delete(b.tool_use_id);
              // Only emit if the write succeeded (output doesn't start with error indicators)
              const lowerOutput = output.toLowerCase();
              if (!lowerOutput.startsWith("error") && !lowerOutput.includes("permission denied")) {
                const relPath = path.relative(projectPath, pending.filePath) || path.basename(pending.filePath);
                let afterBuf: Buffer | null = null;
                try { afterBuf = fs.readFileSync(pending.filePath); } catch { /* deleted */ }

                const isBinary = (pending.before !== null && isBinaryBuffer(pending.before))
                  || (afterBuf !== null && isBinaryBuffer(afterBuf));

                if (isBinary) {
                  webContents.send(CH.SESSION_FILE_CHANGE, {
                    session_id: sessionId,
                    file_change: { path: pending.filePath, relativePath: relPath, diff: "", operation: "write" as const, isBinary: true },
                  });
                } else {
                  const before = pending.before ? pending.before.toString("utf8") : "";
                  const after = afterBuf ? afterBuf.toString("utf8") : "";
                  const diff = createPatch(relPath, before, after, "", "");
                  webContents.send(CH.SESSION_FILE_CHANGE, {
                    session_id: sessionId,
                    file_change: { path: pending.filePath, relativePath: relPath, diff, operation: "write" as const },
                  });
                }
              }
            }
          }
        }
      } else if (msg.type === "result") {
        resultSessionId = msg.session_id;
      } else if (msg.type === "system") {
        const sysMsg = msg as { type: "system"; subtype: string; [key: string]: unknown };
        if (sysMsg.subtype === "compact_boundary") {
          const meta = sysMsg["compact_metadata"] as { trigger: "auto" | "manual"; pre_tokens: number } | undefined;
          webContents.send(CH.SESSION_COMPACTION, {
            session_id: sessionId,
            compaction: {
              id: (sysMsg["uuid"] as string | undefined) ?? `${sessionId}-${Date.now()}`,
              session_id: sessionId,
              trigger: meta?.trigger ?? "auto",
              pre_tokens: meta?.pre_tokens ?? 0,
              timestamp: new Date().toISOString(),
            },
          });
        }
      }
    }
    tracer.endSpan(turnSpanId, "success", {
      firstTokenLatencyMs: firstTokenMs ? firstTokenMs - turnStartMs : undefined,
    });
  } catch (err) {
    tracer.endSpan(turnSpanId, "error", { errorMessage: String(err) });
    throw err;
  } finally {
    unsubTracer();
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

// ── AgentProvider implementation ──────────────────────────────────────────────

export const claudeProvider: AgentProvider = {
  async run(params: AgentProviderParams): Promise<string> {
    const sdkRow = params.db
      .prepare("SELECT sdk_session_id FROM sessions WHERE id = ?")
      .get(params.sessionId) as { sdk_session_id: string | null } | undefined;
    const sdkSessionId = sdkRow?.sdk_session_id ?? null;

    return runClaudeAgentTurn({ ...params, sdkSessionId });
  },

  async listAgents(projectPath: string): Promise<AgentInfo[]> {
    return getClaudeAgents(projectPath);
  },
};
