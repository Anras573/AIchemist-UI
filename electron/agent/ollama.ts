import type { Database } from "better-sqlite3";
import { buildSkillsContext } from "./skills";
import { readAgentFileSystemPrompt } from "./claude";
import { requestQuestion } from "./question";
import { loadManagedMcpServers, createManagedMcpBridge } from "../mcp";
import { loadToolCallsForMessage } from "../sessions";
import { runGatedTool } from "./tool-gate";
import { TurnEmitter, emitToolRoundLimitNotice } from "./turn-emitter";
import {
  createNativeTranscriptRecorder,
  type NativeTranscriptRecorder,
} from "../native-transcript";
import {
  implDeleteFileWithChange,
  implExecuteBash,
  implGlobFiles,
  implListDirectory,
  implReadTextFile,
  implWebFetch,
  implWriteFileWithChange,
} from "./tool-impls";
import type { AgentProvider, AgentProviderParams } from "./provider";
import { getDisabledMcpServers } from "../sessions";
import { readMaxToolRounds } from "../settings";

type ChatRole = "system" | "user" | "assistant" | "tool";

interface OllamaMessage {
  role: ChatRole;
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

interface OllamaModel {
  model?: string;
  name?: string;
}

interface OllamaListResult {
  models?: OllamaModel[];
}

interface OllamaChatChunk {
  message?: Partial<OllamaMessage>;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaClientLike {
  list(): Promise<OllamaListResult>;
  chat(input: {
    model: string;
    messages: OllamaMessage[];
    stream?: boolean;
    tools?: OllamaToolDefinition[];
  }): Promise<AsyncIterable<OllamaChatChunk> | { message?: Partial<OllamaMessage> }>;
}

interface OllamaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ToolExecutionContext {
  db: Database;
  sessionId: string;
  messageId: string;
  projectPath: string;
  projectConfig: AgentProviderParams["projectConfig"];
  emitter: TurnEmitter;
  client: OllamaClientLike;
  delegationDepth: number;
  recorder: NativeTranscriptRecorder | null;
}

export const OLLAMA_NO_MODELS_ERROR =
  "No Ollama models found. Install a model with `ollama pull <model>` or configure one in Project Settings.";

const OLLAMA_SYSTEM_PROMPT = [
  "You are AIchemist, a coding assistant running inside a desktop app.",
  "Use the available tools to inspect and modify the project, run commands, fetch URLs, and ask the user questions when needed.",
  "Never invent file contents or command output. If you need more context, use a tool.",
  "When you need clarification, use ask_user instead of asking in plain text.",
].join(" ");

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

let clientPromise: Promise<OllamaClientLike> | null = null;

async function loadClient(): Promise<OllamaClientLike> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const mod = await import("ollama");
    const host = process.env.OLLAMA_HOST?.trim();
    if (host && typeof mod.Ollama === "function") {
      return new mod.Ollama({ host }) as OllamaClientLike;
    }
    return (mod.default ?? mod) as unknown as OllamaClientLike;
  })();
  return clientPromise;
}

function buildSystemPrompt(params: AgentProviderParams): string {
  const skillsContext = buildSkillsContext(params.skills ?? [], params.projectPath);
  const agentBody = params.agent ? readAgentFileSystemPrompt(params.agent)?.body ?? "" : "";
  const parts = [OLLAMA_SYSTEM_PROMPT, agentBody, skillsContext];
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}

function loadHistory(db: Database, sessionId: string, placeholderMessageId: string): OllamaMessage[] {
  const rows = db
    .prepare(
      `SELECT id, role, content
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC`
    )
    .all(sessionId) as Array<{ id: string; role: string; content: string }>;

  const history: OllamaMessage[] = [];
  for (const row of rows) {
    if (row.id === placeholderMessageId) continue;
    if (row.role === "user") {
      history.push({ role: "user", content: row.content });
      continue;
    }
    if (row.role !== "assistant") continue;

    const toolCalls = loadToolCallsForMessage(db, row.id);
    const toolCallRefs = toolCalls.map((call) => ({
      function: {
        name: call.name,
        arguments: (call.args ?? {}) as Record<string, unknown>,
      },
    }));

    history.push({
      role: "assistant",
      content: row.content,
      ...(toolCallRefs.length > 0 ? { tool_calls: toolCallRefs } : {}),
    });

    for (const call of toolCalls) {
      history.push({
        role: "tool",
        content: stringifyToolResult(call.result),
        tool_name: call.name,
      });
    }
  }
  return history;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "";
  return safeJson(result);
}

/**
 * Ensure the turn's prompt is the final user message. The renderer saves the
 * user message before AGENT_SEND, so it is usually already last in history —
 * but it may differ from `prompt` (GitHub-issue context augmentation) or be
 * missing entirely (skipPersistence turns such as PR draft generation).
 */
function withCurrentPrompt(history: OllamaMessage[], prompt: string): OllamaMessage[] {
  const last = history[history.length - 1];
  if (last && last.role === "user") {
    return [...history.slice(0, -1), { role: "user", content: prompt }];
  }
  return [...history, { role: "user", content: prompt }];
}

function makeToolDefinitions(): OllamaToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from the project and return its text content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative file path" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "List the contents of a directory in the project.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative directory path" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "Find project files matching a glob pattern.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern relative to the project root" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write content to a file, creating parent directories as needed.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative file path" },
            content: { type: "string", description: "Content to write" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_file",
        description: "Delete a file from the project.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative file path" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "execute_bash",
        description: "Execute a shell command and return its output. Always requires approval.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute" },
            cwd: { type: "string", description: "Working directory for the command" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch a URL via HTTP GET and return its content.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ask_user",
        description: "Ask the user a question and wait for the answer before proceeding.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question to ask the user" },
            options: {
              type: "array",
              items: { type: "string" },
              description: "Optional choices to present to the user",
            },
            placeholder: { type: "string", description: "Placeholder for free-form input" },
          },
          required: ["question"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delegate_task",
        description:
          "Delegate a self-contained sub-task to a different locally-installed Ollama model. " +
          "Use when the task suits a specialist model (e.g. a code model for refactoring, a " +
          "reasoning model for planning). The sub-agent receives a fresh context with no " +
          "conversation history and may use filesystem, shell, and web tools. Returns the " +
          "sub-agent's complete response.",
        parameters: {
          type: "object",
          properties: {
            model: {
              type: "string",
              description: "Name of the installed Ollama model to delegate to. Tag suffix is optional — 'codellama' matches any installed codellama variant, preferring ':latest'.",
            },
            prompt: {
              type: "string",
              description:
                "Complete, self-contained prompt for the sub-agent. Include all context it needs; " +
                "it has no access to the current conversation history.",
            },
          },
          required: ["model", "prompt"],
        },
      },
    },
  ];
}

const MAX_DELEGATION_DEPTH = 1;

function resolveInstalledModel(
  available: Array<{ id: string }>,
  requested: string,
): string | undefined {
  if (!requested.includes(":")) {
    // Untagged request (e.g. "codellama"): prefer :latest over other tagged variants,
    // then fall back to the untagged exact form last — so "codellama" picks
    // "codellama:latest" even when bare "codellama" is also installed.
    const prefix = `${requested}:`;
    const variants = available.filter((m) => m.id.startsWith(prefix));
    const latest = variants.find((m) => m.id === `${requested}:latest`);
    if (latest) return latest.id;
    if (variants.length > 0) return variants[0].id;
    if (available.some((m) => m.id === requested)) return requested;
    return undefined;
  }

  // Tagged request: exact match first.
  if (available.some((m) => m.id === requested)) return requested;

  // "codellama:latest" requested but only the untagged "codellama" is installed.
  if (requested.endsWith(":latest")) {
    const withoutLatest = requested.slice(0, -":latest".length);
    if (available.some((m) => m.id === withoutLatest)) return withoutLatest;
  }

  return undefined;
}

const SUB_AGENT_MAX_ROUNDS = 4;
const SUB_AGENT_SYSTEM_PROMPT = [
  "You are a specialised sub-agent delegated a task by an orchestrating AI assistant.",
  "Complete the task using the available tools.",
  "Never invent file contents or command output — use tools to gather real data.",
  "Return a clear, concise result the orchestrating agent can act on directly.",
].join(" ");

async function runDelegatedTurn(
  ctx: ToolExecutionContext,
  subModel: string,
  subPrompt: string,
): Promise<string> {
  const subCtx: ToolExecutionContext = {
    ...ctx,
    delegationDepth: ctx.delegationDepth + 1,
    // Suppress SESSION_DELTA from sub-agents so their streaming text does not
    // interleave with the orchestrator's StreamingBubble in the UI.
    emitter: ctx.emitter.withoutDeltas(),
  };
  // Sub-agents do not get ask_user — questions must be resolved by the orchestrator.
  // delegate_task is kept in the list; the depth guard inside runTool blocks further nesting.
  const subTools = makeToolDefinitions().filter((t) => t.function.name !== "ask_user");
  const noop = {
    hasTool: () => false as const,
    callTool: async () => "Error: MCP tools not available in delegated turns",
  };

  const messages: OllamaMessage[] = [
    { role: "system", content: SUB_AGENT_SYSTEM_PROMPT },
    { role: "user", content: subPrompt },
  ];

  let fullText = "";
  for (let round = 0; round < SUB_AGENT_MAX_ROUNDS; round++) {
    const { text, toolCalls } = await runChatRound(ctx.client, subModel, messages, subTools, subCtx);
    fullText += text;

    if (toolCalls.length === 0) return fullText;

    messages.push({ role: "assistant", content: text, tool_calls: toolCalls });

    for (const toolCall of toolCalls) {
      const output = await executeTool(subCtx, toolCall, noop);
      messages.push({ role: "tool", content: output, tool_name: toolCall.function.name });
    }
  }

  return fullText || "(sub-agent reached tool round limit without producing a final response)";
}

function runTool(
  ctx: ToolExecutionContext,
  name: string,
  args: Record<string, unknown>,
  category: "filesystem" | "shell" | "web" | "custom",
  impl: () => Promise<string>,
): Promise<string> {
  return runGatedTool(ctx, { name, args, category, impl });
}

async function executeTool(
  ctx: ToolExecutionContext,
  toolCall: OllamaToolCall,
  managedMcpBridge: { hasTool(name: string): boolean; callTool(name: string, args: Record<string, unknown>): Promise<string> },
): Promise<string> {
  const name = toolCall.function.name;
  const args = toolCall.function.arguments ?? {};

  switch (name) {
    case "read_file":
      return runTool(ctx, name, args, "filesystem", async () => implReadTextFile(ctx.projectPath, String(args.path ?? "")));
    case "list_directory":
      return runTool(ctx, name, args, "filesystem", async () => implListDirectory(ctx.projectPath, String(args.path ?? "")));
    case "glob":
      return runTool(ctx, name, args, "filesystem", async () => implGlobFiles(ctx.projectPath, String(args.pattern ?? "")));
    case "write_file":
      return runTool(ctx, name, args, "filesystem", async () => {
        const { result, change } = await implWriteFileWithChange(
          { path: String(args.path ?? ""), content: String(args.content ?? "") },
          ctx.projectPath,
        );
        if (change) {
          ctx.emitter.fileChange(change);
        }
        return result;
      });
    case "delete_file":
      return runTool(ctx, name, args, "filesystem", async () => {
        const { result, change } = await implDeleteFileWithChange({ path: String(args.path ?? "") }, ctx.projectPath);
        if (change) {
          ctx.emitter.fileChange(change);
        }
        return result;
      });
    case "execute_bash":
      return runTool(ctx, name, args, "shell", async () => implExecuteBash({
        command: String(args.command ?? ""),
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        projectPath: ctx.projectPath,
      }));
    case "web_fetch":
      return runTool(ctx, name, args, "web", async () => implWebFetch({ url: String(args.url ?? "") }));
    case "ask_user":
      if (ctx.delegationDepth > 0) {
        return runTool(ctx, name, args, "custom", async () => {
          throw new Error("ask_user is not available in delegated turns — the orchestrating agent must handle user interaction.");
        });
      }
      return runTool(ctx, name, args, "custom", async () =>
        requestQuestion(
          ctx.emitter.webContents,
          ctx.sessionId,
          String(args.question ?? ""),
          Array.isArray(args.options) ? args.options.filter((option): option is string => typeof option === "string") : undefined,
          typeof args.placeholder === "string" ? args.placeholder : undefined,
        ).then((answer) => answer || "(no answer provided)")
      );
    case "delegate_task":
      return runTool(ctx, name, args, "custom", async () => {
        if (ctx.delegationDepth >= MAX_DELEGATION_DEPTH) {
          throw new Error(`Delegation depth limit (${MAX_DELEGATION_DEPTH}) reached — sub-agents cannot delegate further`);
        }
        const subModel = String(args.model ?? "").trim();
        const subPrompt = String(args.prompt ?? "").trim();
        if (!subModel) throw new Error(`delegate_task requires a "model" argument`);
        if (!subPrompt) throw new Error(`delegate_task requires a "prompt" argument`);
        const available = await listInstalledModels(ctx.client);
        const resolvedModel = resolveInstalledModel(available, subModel);
        if (!resolvedModel) {
          const list = available.map((m) => m.id).join(", ") || "none installed";
          throw new Error(`model "${subModel}" is not installed. Available: ${list}`);
        }
        return runDelegatedTurn(ctx, resolvedModel, subPrompt);
      });
    default:
      if (managedMcpBridge.hasTool(name)) {
        // Managed MCP tools can do anything, so gate them with the strictest
        // existing approval category instead of treating them as file edits.
        return runTool(ctx, name, args, "shell", async () => managedMcpBridge.callTool(name, args));
      }
      // Route through runTool so the attempt is visible in the UI timeline
      // and persisted to tool_calls — including calls from misbehaving sub-agents.
      return runTool(ctx, name, args, "custom", async () => { throw new Error(`Unsupported tool "${name}"`); });
  }
}

async function runChatRound(
  client: OllamaClientLike,
  model: string,
  messages: OllamaMessage[],
  tools: OllamaToolDefinition[],
  ctx: ToolExecutionContext,
): Promise<{ text: string; toolCalls: OllamaToolCall[] }> {
  const response = await client.chat({
    model,
    messages,
    stream: true,
    tools,
  });

  let fullText = "";
  let toolCalls: OllamaToolCall[] = [];
  const seenToolCalls = new Set<string>();

  if (isAsyncIterable<OllamaChatChunk>(response)) {
    for await (const chunk of response) {
      const delta = chunk.message?.content ?? "";
      if (delta) {
        fullText += delta;
        ctx.emitter.delta(delta);
      }
      if (chunk.message?.tool_calls?.length) {
        for (const toolCall of chunk.message.tool_calls) {
          const key = `${toolCall.function.name}::${safeJson(toolCall.function.arguments ?? {})}`;
          if (seenToolCalls.has(key)) continue;
          seenToolCalls.add(key);
          toolCalls.push(toolCall);
        }
      }
      // Emit as soon as token counts appear on any chunk (Ollama includes them on the done chunk,
      // but emit eagerly so the indicator updates the moment the data is available).
      if (chunk.prompt_eval_count != null || chunk.eval_count != null) {
        ctx.emitter.usage({
          input_tokens: chunk.prompt_eval_count ?? 0,
          output_tokens: chunk.eval_count ?? 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        });
        ctx.recorder?.usage({
          input: chunk.prompt_eval_count ?? 0,
          output: chunk.eval_count ?? 0,
          cacheRead: 0,
          cacheCreation: 0,
        });
      }
    }
    return { text: fullText, toolCalls };
  }

  const message = response.message ?? {};
  const text = message.content ?? "";
  if (text) {
    fullText += text;
    ctx.emitter.delta(text);
  }
  return { text: fullText, toolCalls: message.tool_calls ?? [] };
}

export async function runOllamaAgentTurn(params: AgentProviderParams): Promise<string> {
  const client = await loadClient();
  const history = loadHistory(params.db, params.sessionId, params.messageId);
  const model = await resolveModel(client, params.projectConfig.model);

  // When noTools is true (text-only generation turns), skip all tool definitions
  // and MCP bridge startup to prevent any filesystem/shell side-effects.
  const managedMcpBridge = params.noTools
    ? null
    : await createManagedMcpBridge(
        loadManagedMcpServers({ excludeNames: new Set(getDisabledMcpServers(params.db, params.sessionId)) }),
        params.projectPath,
      );
  const tools = params.noTools ? [] : [...makeToolDefinitions(), ...(managedMcpBridge?.tools ?? [])];
  // noTools turns are text-only generation (e.g. PR draft generation) — skip
  // transcript recording so they don't surface as empty turns in the Traces tab.
  const recorder = params.noTools ? null : createNativeTranscriptRecorder(params.sessionId, "ollama");
  const ctx: ToolExecutionContext = {
    db: params.db,
    sessionId: params.sessionId,
    messageId: params.messageId,
    projectPath: params.projectPath,
    projectConfig: params.projectConfig,
    emitter: new TurnEmitter(params.webContents, params.sessionId),
    client,
    delegationDepth: 0,
    recorder,
  };

  const systemPrompt = buildSystemPrompt(params);
  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    ...(params.prompt?.trim() ? withCurrentPrompt(history, params.prompt) : history),
  ];

  // Open the transcript turn only after the throwing setup (system prompt /
  // history) succeeds, so a failed setup can't leave an unterminated
  // "running" span. The MCP bridge was already created above.
  recorder?.turnStart(model);

  const maxToolRounds = readMaxToolRounds();
  let fullText = "";
  let turnStatus: "success" | "error" = "error";
  try {
    for (let round = 0; round < maxToolRounds; round++) {
      const { text, toolCalls } = await runChatRound(client, model, messages, tools, ctx);
      fullText += text;

      if (toolCalls.length === 0) {
        turnStatus = "success";
        return fullText;
      }
      if (params.noTools) {
        throw new Error("Ollama returned tool calls while tools are disabled");
      }

      messages.push({
        role: "assistant",
        content: text,
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const output = await executeTool(ctx, toolCall, managedMcpBridge ?? { hasTool: () => false, callTool: async () => `Error: tools are disabled` });
        messages.push({
          role: "tool",
          content: output,
          tool_name: toolCall.function.name,
        });
      }
    }

    // The model still wanted to call tools but we hit the configured round
    // cap. Surface the truncation to the user (and preserve any partial text)
    // instead of throwing, so the turn isn't silently lost mid-workflow.
    fullText += emitToolRoundLimitNotice(ctx.emitter, maxToolRounds);
    turnStatus = "success";
    return fullText;
  } finally {
    await managedMcpBridge?.close();
    recorder?.turnEnd(turnStatus);
  }
}

async function listInstalledModels(client: OllamaClientLike): Promise<Array<{ id: string; name: string }>> {
  const list = await client.list();
  return (list.models ?? [])
    .map((m) => {
      const id = (m.model ?? m.name ?? "").trim();
      const name = id;
      return id ? { id, name } : null;
    })
    .filter((m): m is { id: string; name: string } => m !== null);
}

async function resolveModel(client: OllamaClientLike, configuredModel?: string): Promise<string> {
  const explicit = configuredModel?.trim();
  if (explicit) return explicit;
  const discovered = await listInstalledModels(client);
  const fallback = discovered[0]?.id;
  if (fallback) return fallback;
  throw new Error(OLLAMA_NO_MODELS_ERROR);
}

export async function getOllamaModels(): Promise<Array<{ id: string; name: string }>> {
  const client = await loadClient();
  return listInstalledModels(client);
}

export function _resetOllamaClientForTests(): void {
  clientPromise = null;
}

export const ollamaProvider: AgentProvider = {
  run: (params: AgentProviderParams) => runOllamaAgentTurn(params),
  async listModels(): Promise<Array<{ id: string; name: string }>> {
    return getOllamaModels();
  },
};
