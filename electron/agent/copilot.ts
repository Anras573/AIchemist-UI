import type {
  CopilotClient as CopilotClientType,
  PermissionRequest,
  PermissionRequestResult,
  CustomAgentConfig,
} from "@github/copilot-sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentInfo, ProjectConfig } from "../../src/types/index";
import { getApiKey } from "../config";
import * as CH from "../ipc-channels";
import * as tracer from "../tracer";
import { requestApproval, needsApproval, requiresApproval } from "./approval";
import { buildSkillsContext } from "./skills";
import {
  implWriteFileWithChange,
  implDeleteFileWithChange,
  implExecuteBash,
  implWebFetch,
} from "./tool-impls";
import type { AgentProvider, AgentProviderParams } from "./provider";

// ── Singleton client ──────────────────────────────────────────────────────────

let clientInstance: CopilotClientType | null = null;

/**
 * Maps AIchemist session ID → Copilot SDK session ID so we can resume the
 * same SDK session across multiple agent turns, preserving conversation history.
 */
const copilotSessionIds = new Map<string, string>();

async function getClient(): Promise<CopilotClientType> {
  if (clientInstance) return clientInstance;
  const { CopilotClient } = await import("@github/copilot-sdk");
  const githubToken = getApiKey("github") ?? undefined;
  const client = new CopilotClient({ githubToken });
  await client.start();
  clientInstance = client;
  return client;
}

/** Gracefully stop the shared Copilot CLI client. */
export async function stopCopilotClient(): Promise<void> {
  if (clientInstance) {
    await clientInstance.stop();
    clientInstance = null;
    copilotSessionIds.clear();
  }
}

/** Return the list of models available for the authenticated Copilot user. */
export async function getCopilotModels(): Promise<Array<{ id: string; name: string }>> {
  const client = await getClient();
  const models = await client.listModels();
  return models.map((m) => ({ id: m.id, name: m.name }));
}

// ── Agent scanning ────────────────────────────────────────────────────────────

type CopilotAgentEntry = { name: string; description: string; prompt: string; filePath: string };
type CopilotAgentParsed = Omit<CopilotAgentEntry, "filePath">;

/** Parse a Copilot agent markdown file's YAML frontmatter + body. */
function parseCopilotAgentFile(content: string): CopilotAgentParsed | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
  if (!match) return null;

  const fm = match[1];
  const body = (match[2] ?? "").trim();

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");

  const descMatch = fm.match(/^description:\s*(.+)$/m);
  const description = descMatch
    ? descMatch[1].trim().replace(/^['"]|['"]$/g, "")
    : "";

  // The body becomes the agent's system prompt — must be non-empty
  if (!body) return null;

  return { name, description, prompt: body };
}

/** Scan a directory for `*.md` agent files and return parsed entries. */
function scanAgentDir(dir: string): CopilotAgentEntry[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.isDirectory() && e.name.endsWith(".md"))
      .flatMap((file) => {
        try {
          const filePath = path.join(dir, file.name);
          const content = fs.readFileSync(filePath, "utf8");
          const entry = parseCopilotAgentFile(content);
          return entry ? [{ ...entry, filePath }] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Returns available Copilot sub-agents by merging:
 * 1. Project-local agents: `{projectPath}/.agents/copilot-agents/*.md`
 * 2. Global agents: `~/.github-copilot/agents/*.md`
 *
 * Project-local agents take priority over globals with the same name.
 */
export function listCopilotAgents(projectPath: string): AgentInfo[] {
  const projectDir = path.join(projectPath, ".agents", "copilot-agents");
  const globalDir = path.join(os.homedir(), ".github-copilot", "agents");

  const projectEntries = scanAgentDir(projectDir);
  const globalEntries = scanAgentDir(globalDir);

  const projectNames = new Set(projectEntries.map((a) => a.name));
  const merged = [
    ...projectEntries,
    ...globalEntries.filter((a) => !projectNames.has(a.name)),
  ];

  return merged.map(({ name, description, filePath }) => ({ name, description, path: filePath, editable: true }));
}

/** Convert scanned agent entries to CustomAgentConfig objects for the SDK. */
function toCustomAgentConfigs(projectPath: string): CustomAgentConfig[] {
  const projectDir = path.join(projectPath, ".agents", "copilot-agents");
  const globalDir = path.join(os.homedir(), ".github-copilot", "agents");

  const projectEntries = scanAgentDir(projectDir);
  const globalEntries = scanAgentDir(globalDir);

  const projectNames = new Set(projectEntries.map((a) => a.name));
  return [
    ...projectEntries,
    ...globalEntries.filter((a) => !projectNames.has(a.name)),
  ].map(({ name, description, prompt }) => ({
    name,
    displayName: name,
    description,
    prompt,
  }));
}

/**
 * Find a Copilot agent by name and return its prompt body.
 * Searches project-local agents first, then global agents.
 */
function findCopilotAgentBody(agentName: string, projectPath: string): string | null {
  const projectDir = path.join(projectPath, ".agents", "copilot-agents");
  const globalDir = path.join(os.homedir(), ".github-copilot", "agents");
  for (const dir of [projectDir, globalDir]) {
    for (const entry of scanAgentDir(dir)) {
      if (entry.name === agentName) return entry.prompt;
    }
  }
  return null;
}

// ── Agent turn ────────────────────────────────────────────────────────────────

export async function runCopilotAgentTurn(params: {
  sessionId: string;
  prompt: string;
  projectPath: string;
  projectConfig: ProjectConfig;
  webContents: Electron.WebContents;
  agent?: string;
  skills?: string[];
}): Promise<string> {
  const { sessionId, prompt, projectPath, projectConfig, webContents, agent, skills } = params;

  const { defineTool } = await import("@github/copilot-sdk");

  const client = await getClient();

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

  // ── Shared helper ───────────────────────────────────────────────────────────

  async function runTool(
    name: string,
    args: unknown,
    category: "filesystem" | "web",
    impl: () => Promise<string>
  ): Promise<string> {
    const toolSpanId = tracer.startSpan({
      sessionId,
      type: "tool",
      name,
      parentId: turnSpanId,
      startMs: Date.now(),
      meta: { input: args as Record<string, unknown> },
    });
    webContents.send(CH.SESSION_TOOL_CALL, { session_id: sessionId, tool_name: name, input: args });

    if (requiresApproval(sessionId, projectConfig, category, name, args)) {
      const approved = await requestApproval(webContents, sessionId, name, args);
      if (!approved) {
        const msg = "Tool call denied by user.";
        tracer.endSpan(toolSpanId, "error", { denied: true });
        webContents.send(CH.SESSION_TOOL_RESULT, { session_id: sessionId, tool_name: name, output: msg });
        return msg;
      }
    }

    try {
      const output = await impl();
      tracer.endSpan(toolSpanId, "success");
      webContents.send(CH.SESSION_TOOL_RESULT, { session_id: sessionId, tool_name: name, output });
      return output;
    } catch (e) {
      tracer.endSpan(toolSpanId, "error", { errorMessage: String(e) });
      throw e;
    }
  }

  // ── Tool definitions ────────────────────────────────────────────────────────

  const writeFileTool = defineTool<{ path: string; content: string }>(
    "write_file",
    {
      description: "Write content to a file, creating parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
      handler: (args) => runTool("write_file", args, "filesystem", async () => {
      const { result, change } = await implWriteFileWithChange(args, projectPath);
      if (change) webContents.send(CH.SESSION_FILE_CHANGE, { session_id: sessionId, file_change: change });
      return result;
    }),
    }
  );

  const deleteFileTool = defineTool<{ path: string }>("delete_file", {
    description: "Delete a file from the filesystem.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path of the file to delete" },
      },
      required: ["path"],
    },
    handler: (args) => runTool("delete_file", args, "filesystem", async () => {
      const { result, change } = await implDeleteFileWithChange(args, projectPath);
      if (change) webContents.send(CH.SESSION_FILE_CHANGE, { session_id: sessionId, file_change: change });
      return result;
    }),
  });

  const executeBashTool = defineTool<{ command: string; cwd?: string }>(
    "execute_bash",
    {
      description: "Execute a shell command and return its output. Always requires approval.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          cwd: { type: "string", description: "Working directory for the command" },
        },
        required: ["command"],
      },
      handler: async (args) => {
        webContents.send(CH.SESSION_TOOL_CALL, { session_id: sessionId, tool_name: "execute_bash", input: args });

        // Shell is always approval-gated regardless of policy
        const approved = await requestApproval(webContents, sessionId, "execute_bash", args);
        if (!approved) {
          const msg = "Tool call denied by user.";
          webContents.send(CH.SESSION_TOOL_RESULT, { session_id: sessionId, tool_name: "execute_bash", output: msg });
          return msg;
        }

        const output = await implExecuteBash(args);
        webContents.send(CH.SESSION_TOOL_RESULT, { session_id: sessionId, tool_name: "execute_bash", output });
        return output;
      },
    }
  );

  const webFetchTool = defineTool<{ url: string }>("web_fetch", {
    description: "Fetch a URL via HTTP GET and return its content.",
    // web_fetch is also a Copilot CLI built-in; override it so our version
    // handles the call (gives us IPC visibility + approval gating).
    overridesBuiltInTool: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
    handler: (args) => runTool("web_fetch", args, "web", () => implWebFetch(args)),
  });

  // ── Permission handler for built-in CLI tools ───────────────────────────────
  // Our custom defineTool handlers gate approval themselves; this handles the
  // CLI's built-in tools (read_file, edit_file, run_shell, etc.).
  const onPermissionRequest = async (
    request: PermissionRequest
  ): Promise<PermissionRequestResult> => {
    let category: "filesystem" | "shell" | "web" | null = null;

    switch (request.kind) {
      case "shell":
        category = "shell";
        break;
      case "write":
      case "read":
      case "mcp":
        category = "filesystem";
        break;
      case "url":
        category = "web";
        break;
      case "custom-tool":
        // Custom defineTool handlers manage their own approval gate
        return { kind: "approved" };
    }

    if (category === null) return { kind: "approved" };

    // Shell operations are always approval-gated; others depend on project config
    const shouldGate =
      category === "shell" || needsApproval(projectConfig, category);

    if (!shouldGate) return { kind: "approved" };

    const approved = await requestApproval(
      webContents,
      sessionId,
      request.kind,
      request
    );

    return approved
      ? { kind: "approved" }
      : { kind: "denied-interactively-by-user" };
  };

  // ── Create or resume session ────────────────────────────────────────────────

  const skillsContext = buildSkillsContext(skills ?? [], projectPath);

  // When a specific agent is selected, inject its system prompt via `systemMessage`
  // (the same pattern Claude uses with `systemPrompt`). `customAgents` are sub-agent
  // delegation configs — they are NOT a replacement for the session system prompt, so
  // selecting an agent via `session.rpc.agent.select()` only routes sub-tasks; it does
  // not change the primary instructions the model operates under.
  //
  // When no agent is selected, fall back to registering all available agents as
  // custom sub-agents so Copilot can automatically delegate based on inference.
  let systemMessageContent: string | null = null;
  let customAgents: CustomAgentConfig[] = [];

  if (agent) {
    const agentBody = findCopilotAgentBody(agent, projectPath);
    systemMessageContent = (agentBody ?? "") + skillsContext;
  } else {
    customAgents = toCustomAgentConfigs(projectPath);
    if (skillsContext) {
      if (customAgents.length > 0) {
        customAgents = customAgents.map((a) => ({ ...a, prompt: a.prompt + skillsContext }));
      } else {
        customAgents = [{ name: "_skills", description: "Active skills context", prompt: skillsContext }];
      }
    }
  }

  const sessionConfig = {
    model: projectConfig.model,
    streaming: true,
    workingDirectory: projectPath,
    tools: [writeFileTool, deleteFileTool, executeBashTool, webFetchTool],
    onPermissionRequest,
    ...(systemMessageContent ? { systemMessage: { mode: "append" as const, content: systemMessageContent } } : {}),
    ...(customAgents.length > 0 ? { customAgents } : {}),
  };

  // Resume the existing Copilot SDK session for this AIchemist session (if any)
  // so conversation history is preserved across turns. Fall back to creating a
  // new session if no prior session exists or resuming fails.
  let session: Awaited<ReturnType<typeof client.createSession>>;
  const existingCopilotSessionId = copilotSessionIds.get(sessionId);
  if (existingCopilotSessionId) {
    try {
      session = await client.resumeSession(existingCopilotSessionId, sessionConfig);
    } catch {
      // Session state was lost (e.g. CLI restart) — create fresh
      copilotSessionIds.delete(sessionId);
      session = await client.createSession(sessionConfig);
      copilotSessionIds.set(sessionId, session.sessionId);
    }
  } else {
    session = await client.createSession(sessionConfig);
    copilotSessionIds.set(sessionId, session.sessionId);
  }

  // ── Event listeners — set up before sending ─────────────────────────────────

  // Names of our custom defineTool handlers — they already send their own TOOL_CALL/RESULT events
  const customToolNames = new Set(["execute_bash", "write_file", "delete_file", "web_fetch"]);

  // Track toolCallId → toolName for built-in tools (tool.execution_complete has no toolName)
  const toolCallIdToName = new Map<string, string>();

  let fullText = "";
  const done = new Promise<void>((resolve, reject) => {
    // The SDK emits "assistant.message" each time the accumulated text grows
    // (streaming). Track previous length to compute incremental deltas.
    session.on("assistant.message", (event) => {
      const newText: string = (event.data as { content: string }).content ?? "";
      const delta = newText.slice(fullText.length);
      fullText = newText;
      if (delta) {
        if (!firstTokenMs) firstTokenMs = Date.now();
        webContents.send(CH.SESSION_DELTA, {
          session_id: sessionId,
          text_delta: delta,
        });
      }
    });

    // Track tool execution start for built-in CLI tools
    session.on("tool.execution_start", (event) => {
      const data = event.data as {
        toolCallId: string;
        toolName: string;
        arguments?: Record<string, unknown>;
      };
      toolCallIdToName.set(data.toolCallId, data.toolName);
      if (!customToolNames.has(data.toolName)) {
        const spanId = tracer.startSpan({
          sessionId,
          type: "tool",
          name: data.toolName,
          parentId: turnSpanId,
          startMs: Date.now(),
          meta: { input: data.arguments ?? {} },
        });
        toolCallIdToName.set(`span:${data.toolCallId}`, spanId);
        webContents.send(CH.SESSION_TOOL_CALL, {
          session_id: sessionId,
          tool_name: data.toolName,
          tool_call_id: data.toolCallId,
          input: data.arguments ?? {},
        });
      }
    });

    // Capture results for built-in CLI tools
    session.on("tool.execution_complete", (event) => {
      const data = event.data as {
        toolCallId: string;
        success: boolean;
        result?: {
          content: string;
          detailedContent?: string;
          contents?: Array<
            | { type: "text"; text: string }
            | { type: "terminal"; text: string; exitCode?: number }
          >;
        };
      };
      const toolName = toolCallIdToName.get(data.toolCallId) ?? "unknown";
      if (!customToolNames.has(toolName)) {
        // Prefer terminal content blocks, then detailedContent, then content
        const terminalBlock = data.result?.contents?.find((c) => c.type === "terminal");
        const output = terminalBlock
          ? (terminalBlock as { type: "terminal"; text: string }).text
          : (data.result?.detailedContent ?? data.result?.content ?? "");
        const spanId = toolCallIdToName.get(`span:${data.toolCallId}`);
        if (spanId) tracer.endSpan(spanId, data.success ? "success" : "error");
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: toolName,
          output,
        });
      }
    });

    // Compaction events — emitted by the SDK when context window is managed
    session.on("session.compaction_complete", (event) => {
      const data = event.data as {
        success: boolean;
        preCompactionTokens?: number;
        tokensRemoved?: number;
      };
      if (data.success) {
        webContents.send(CH.SESSION_COMPACTION, {
          session_id: sessionId,
          compaction: {
            id: `compaction-${Date.now()}`,
            timestamp: new Date().toISOString(),
            trigger: "auto" as const,
            pre_tokens: data.preCompactionTokens ?? 0,
          },
        });
      }
    });

    // Reasoning / extended thinking events
    session.on("assistant.reasoning_delta", (event) => {
      const data = event.data as { reasoningId: string; deltaContent: string };
      webContents.send(CH.SESSION_THINKING_DELTA, {
        session_id: sessionId,
        text_delta: data.deltaContent,
      });
    });

    session.on("assistant.reasoning", () => {
      webContents.send(CH.SESSION_THINKING_DONE, { session_id: sessionId });
    });

    session.on("session.idle", () => resolve());
    session.on("session.error", (event) => {
      reject(new Error((event.data as { message: string }).message ?? "Copilot session error"));
    });
    session.on("session.shutdown", () => reject(new Error("Copilot session aborted")));
  });

  // ── Send & wait ─────────────────────────────────────────────────────────────

  try {
    webContents.send(CH.SESSION_STATUS, {
      session_id: sessionId,
      status: "running",
    });

    await session.send({ prompt });
    await done;

    tracer.endSpan(turnSpanId, "success", {
      firstTokenLatencyMs: firstTokenMs ? firstTokenMs - turnStartMs : undefined,
    });
    webContents.send(CH.SESSION_STATUS, {
      session_id: sessionId,
      status: "complete",
    });
  } catch (err) {
    tracer.endSpan(turnSpanId, "error", { errorMessage: String(err) });
    webContents.send(CH.SESSION_STATUS, {
      session_id: sessionId,
      status: "error",
    });
    throw err;
  } finally {
    unsubTracer();
    await session.disconnect();
  }

  return fullText;
}

// ── AgentProvider implementation ──────────────────────────────────────────────

export const copilotProvider: AgentProvider = {
  run: (params: AgentProviderParams) => runCopilotAgentTurn(params),

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    return getCopilotModels();
  },

  async listAgents(projectPath: string): Promise<AgentInfo[]> {
    return listCopilotAgents(projectPath);
  },

  async stop(): Promise<void> {
    return stopCopilotClient();
  },
};
