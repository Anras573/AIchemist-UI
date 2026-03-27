import type { McpSdkServerConfigWithInstance, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "better-sqlite3";
import type { AgentInfo, ProjectConfig } from "../../src/types/index";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as CH from "../ipc-channels";
import * as tracer from "../tracer";
import { createApprovalMcpServer } from "./mcp-tools";
import { buildSkillsContext } from "./skills";
import { getAnthropicConfig, resolveClaudePath } from "../config";
import type { AgentProvider, AgentProviderParams } from "./provider";

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
    await createApprovalMcpServer(webContents, sessionId, projectConfig);

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
  const queryStream: AsyncGenerator<SDKMessage, void> = query({
    prompt,
    options: {
      resume: sdkSessionId ?? undefined,
      model: effectiveModel,
      cwd: projectPath,
      mcpServers: { "aichemist-tools": mcpServer },
      settingSources: ["local", "user", "project"],
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Glob", "LS", "Skill", "Agent"],
      includePartialMessages: true,
      systemPrompt,
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      ...(sdkAgent ? { agent: sdkAgent } : {}),
    },
  });

  let resultSessionId: string | null = null;
  let fullText = "";

  // Map tool_use_id → tool_name/spanId so we can label results and end spans
  const toolUseIdToName = new Map<string, string>();
  const toolUseIdToSpanId = new Map<string, string>();

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
        if (event["type"] === "content_block_delta") {
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
          }
        }
      } else if (msg.type === "assistant") {
        // Completed assistant turn — emit tool_use blocks for native SDK tools
        // (custom MCP tools emit their own SESSION_TOOL_CALL in mcp-tools.ts)
        const content = (msg.message as { content: unknown[] }).content;
        for (const block of content) {
          const b = block as { type: string; id?: string; name?: string; input?: unknown };
          if (b.type === "tool_use" && b.name) {
            if (b.id) {
              toolUseIdToName.set(b.id, b.name);
              const toolSpanId = tracer.startSpan({
                sessionId,
                type: "tool",
                name: b.name,
                parentId: turnSpanId,
                startMs: Date.now(),
                meta: { input: b.input ?? {} },
              });
              toolUseIdToSpanId.set(b.id, toolSpanId);
            }
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
            const spanId = toolUseIdToSpanId.get(b.tool_use_id);
            if (spanId) tracer.endSpan(spanId, "success");
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
