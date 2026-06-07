import type { Database } from "better-sqlite3";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as CH from "../ipc-channels";
import { buildSkillsContext } from "./skills";
import { readAgentFileSystemPrompt } from "./claude";
import { requestApproval, requiresApproval } from "./approval";
import { requestQuestion } from "./question";
import { loadManagedMcpServers, createManagedMcpBridge } from "../mcp";
import {
  loadToolCallsForMessage,
  saveToolCall,
  updateToolCallStatus,
} from "../sessions";
import {
  implDeleteFileWithChange,
  implExecuteBash,
  implWebFetch,
  implWriteFileWithChange,
} from "./tool-impls";
import type { AgentProvider, AgentProviderParams } from "./provider";
import { getDisabledMcpServers } from "../sessions";

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
  webContents: Electron.WebContents;
  client: OllamaClientLike;
  delegationDepth: number;
}

export const OLLAMA_NO_MODELS_ERROR =
  "No Ollama models found. Install a model with `ollama pull <model>` or configure one in Project Settings.";

const OLLAMA_SYSTEM_PROMPT = [
  "You are AIchemist, a coding assistant running inside a desktop app.",
  "Use the available tools to inspect and modify the project, run commands, fetch URLs, and ask the user questions when needed.",
  "Never invent file contents or command output. If you need more context, use a tool.",
  "When you need clarification, use ask_user instead of asking in plain text.",
].join(" ");

const MAX_TOOL_ROUNDS = 8;
const MAX_READ_BYTES = 512 * 1024;

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resolveProjectPath(projectPath: string, inputPath: string): string {
  const root = fs.realpathSync(path.resolve(projectPath));
  const candidate = path.resolve(root, inputPath);
  const rel = path.relative(root, candidate).replace(/\\/g, "/");
  if (isSensitiveRelativePath(rel)) {
    throw new Error(`Access to sensitive path is not allowed: "${rel}"`);
  }
  const resolved = fs.realpathSync(candidate);
  const resolvedRel = path.relative(root, resolved).replace(/\\/g, "/");
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes project boundary: "${inputPath}"`);
  }
  if (isSensitiveRelativePath(resolvedRel)) {
    throw new Error(`Access to sensitive path is not allowed: "${resolvedRel}"`);
  }
  return resolved;
}

function isSensitiveRelativePath(relPath: string): boolean {
  return [
    /(?:^|\/)\.git(?:\/|$)/,
    /(?:^|\/)node_modules(?:\/|$)/,
    /(?:^|\/|^)\.env(\.|$)/,
  ].some((pattern) => pattern.test(relPath));
}

function shouldIgnoreDir(name: string): boolean {
  return [
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".turbo",
    "__pycache__",
    ".cache",
    ".parcel-cache",
    ".vite",
    "coverage",
    ".nyc_output",
  ].includes(name);
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let re = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        if (normalized[i + 1] === "/") {
          i++;
          re += "(?:.*\\/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re);
}

function readTextFile(projectPath: string, inputPath: string): string {
  const resolved = resolveProjectPath(projectPath, inputPath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Not a file: "${inputPath}"`);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`File too large (${Math.round(stat.size / 1024)} KB). Only files under 512 KB can be previewed.`);
  }
  const buf = fs.readFileSync(resolved);
  if (isBinaryBuffer(buf)) {
    return safeJson({
      path: resolved,
      is_binary: true,
      size_bytes: buf.length,
      content: "",
    });
  }
  return buf.toString("utf8");
}

function listDirectory(projectPath: string, inputPath: string): string {
  const resolved = resolveProjectPath(projectPath, inputPath || ".");
  const dirents = fs.readdirSync(resolved, { withFileTypes: true });
  const filtered = dirents.filter((d) => {
    const entryPath = path.join(resolved, d.name);
    const entryRel = path.relative(resolved, entryPath).replace(/\\/g, "/");
    return !shouldIgnoreDir(d.name) && !isSensitiveRelativePath(entryRel);
  });
  const truncated = filtered.length > 500;
  const visible = truncated ? filtered.slice(0, 500) : filtered;
  const entries = visible.map((dirent) => {
    const entryPath = path.join(resolved, dirent.name);
    let size_bytes = 0;
    if (!dirent.isDirectory()) {
      try {
        size_bytes = fs.statSync(entryPath).size;
      } catch {
        size_bytes = 0;
      }
    }
    return {
      name: dirent.name,
      path: entryPath,
      is_dir: dirent.isDirectory(),
      size_bytes,
    };
  });
  return safeJson({ path: resolved, truncated, entries });
}

function walkGlob(
  root: string,
  cwd: string,
  pattern: RegExp,
  out: string[],
  limit: number,
): void {
  if (out.length >= limit) return;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (out.length >= limit) return;
    const abs = path.join(cwd, dirent.name);
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (shouldIgnoreDir(dirent.name) || isSensitiveRelativePath(rel)) continue;
    if (dirent.isDirectory()) {
      walkGlob(root, abs, pattern, out, limit);
      continue;
    }
    if (pattern.test(rel) || pattern.test(path.basename(rel))) {
      out.push(abs);
    }
  }
}

function globFiles(projectPath: string, inputPattern: string): string {
  const pattern = inputPattern.trim();
  if (!pattern) return safeJson({ pattern, matches: [] as string[] });

  const root = fs.realpathSync(path.resolve(projectPath));
  const normalized = pattern.replace(/\\/g, "/");
  const regex = globPatternToRegExp(
    path.isAbsolute(normalized) ? path.relative(root, normalized).replace(/\\/g, "/") : normalized,
  );
  const matches: string[] = [];
  walkGlob(root, root, regex, matches, 200);
  return safeJson({ pattern, matches, truncated: matches.length >= 200 });
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
              description: "Name of the installed Ollama model to delegate to. Tag suffix is optional — 'codellama' matches 'codellama:latest'.",
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
  if (available.some((m) => m.id === requested)) return requested;
  // "codellama" requested, "codellama:latest" installed
  const withLatest = `${requested}:latest`;
  if (available.some((m) => m.id === withLatest)) return withLatest;
  // "codellama:latest" requested, "codellama" installed (untagged)
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
  const subCtx: ToolExecutionContext = { ...ctx, delegationDepth: ctx.delegationDepth + 1 };
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

async function runTool(
  ctx: ToolExecutionContext,
  name: string,
  args: Record<string, unknown>,
  category: "filesystem" | "shell" | "web" | "custom",
  impl: () => Promise<string>,
): Promise<string> {
  const toolCallId = crypto.randomUUID();
  const needsGate = category !== "custom" && requiresApproval(ctx.sessionId, ctx.projectConfig, category, name, args);
  ctx.webContents.send(CH.SESSION_TOOL_CALL, {
    session_id: ctx.sessionId,
    tool_name: name,
    tool_call_id: toolCallId,
    input: args,
  });
  saveToolCall(ctx.db, {
    id: toolCallId,
    messageId: ctx.messageId,
    name,
    args,
    status: needsGate ? "pending_approval" : "approved",
    category,
  });

  if (needsGate) {
    const approved = await requestApproval(ctx.webContents, ctx.sessionId, name, args);
    if (!approved) {
      const denied = "Tool call denied by user.";
      updateToolCallStatus(ctx.db, toolCallId, "rejected", denied);
      ctx.webContents.send(CH.SESSION_TOOL_RESULT, {
        session_id: ctx.sessionId,
        tool_name: name,
        output: denied,
      });
      return denied;
    }
    updateToolCallStatus(ctx.db, toolCallId, "approved");
  }

  try {
    const output = await impl();
    updateToolCallStatus(ctx.db, toolCallId, "complete", output);
    ctx.webContents.send(CH.SESSION_TOOL_RESULT, {
      session_id: ctx.sessionId,
      tool_name: name,
      output,
    });
    return output;
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    updateToolCallStatus(ctx.db, toolCallId, "error", output);
    ctx.webContents.send(CH.SESSION_TOOL_RESULT, {
      session_id: ctx.sessionId,
      tool_name: name,
      output,
    });
    return output;
  }
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
      return runTool(ctx, name, args, "filesystem", async () => readTextFile(ctx.projectPath, String(args.path ?? "")));
    case "list_directory":
      return runTool(ctx, name, args, "filesystem", async () => listDirectory(ctx.projectPath, String(args.path ?? "")));
    case "glob":
      return runTool(ctx, name, args, "filesystem", async () => globFiles(ctx.projectPath, String(args.pattern ?? "")));
    case "write_file":
      return runTool(ctx, name, args, "filesystem", async () => {
        const { result, change } = await implWriteFileWithChange(
          { path: String(args.path ?? ""), content: String(args.content ?? "") },
          ctx.projectPath,
        );
        if (change) {
          ctx.webContents.send(CH.SESSION_FILE_CHANGE, { session_id: ctx.sessionId, file_change: change });
        }
        return result;
      });
    case "delete_file":
      return runTool(ctx, name, args, "filesystem", async () => {
        const { result, change } = await implDeleteFileWithChange({ path: String(args.path ?? "") }, ctx.projectPath);
        if (change) {
          ctx.webContents.send(CH.SESSION_FILE_CHANGE, { session_id: ctx.sessionId, file_change: change });
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
        return runTool(ctx, name, args, "custom", async () =>
          "Error: ask_user is not available in delegated turns — the orchestrating agent must handle user interaction."
        );
      }
      return runTool(ctx, name, args, "custom", async () =>
        requestQuestion(
          ctx.webContents,
          ctx.sessionId,
          String(args.question ?? ""),
          Array.isArray(args.options) ? args.options.filter((option): option is string => typeof option === "string") : undefined,
          typeof args.placeholder === "string" ? args.placeholder : undefined,
        ).then((answer) => answer || "(no answer provided)")
      );
    case "delegate_task":
      return runTool(ctx, name, args, "custom", async () => {
        if (ctx.delegationDepth >= MAX_DELEGATION_DEPTH) {
          return `Error: delegation depth limit (${MAX_DELEGATION_DEPTH}) reached — sub-agents cannot delegate further`;
        }
        const subModel = String(args.model ?? "").trim();
        const subPrompt = String(args.prompt ?? "").trim();
        if (!subModel) return `Error: delegate_task requires a "model" argument`;
        if (!subPrompt) return `Error: delegate_task requires a "prompt" argument`;
        const available = await listInstalledModels(ctx.client);
        const resolvedModel = resolveInstalledModel(available, subModel);
        if (!resolvedModel) {
          const list = available.map((m) => m.id).join(", ") || "none installed";
          return `Error: model "${subModel}" is not installed. Available: ${list}`;
        }
        return runDelegatedTurn(ctx, resolvedModel, subPrompt);
      });
    default:
      if (managedMcpBridge.hasTool(name)) {
        // Managed MCP tools can do anything, so gate them with the strictest
        // existing approval category instead of treating them as file edits.
        return runTool(ctx, name, args, "shell", async () => managedMcpBridge.callTool(name, args));
      }
      return `Error: Unsupported tool "${name}"`;
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
        ctx.webContents.send(CH.SESSION_DELTA, {
          session_id: ctx.sessionId,
          text_delta: delta,
        });
      }
      if (chunk.message?.tool_calls?.length) {
        for (const toolCall of chunk.message.tool_calls) {
          const key = `${toolCall.function.name}::${safeJson(toolCall.function.arguments ?? {})}`;
          if (seenToolCalls.has(key)) continue;
          seenToolCalls.add(key);
          toolCalls.push(toolCall);
        }
      }
    }
    return { text: fullText, toolCalls };
  }

  const message = response.message ?? {};
  const text = message.content ?? "";
  if (text) {
    fullText += text;
    ctx.webContents.send(CH.SESSION_DELTA, {
      session_id: ctx.sessionId,
      text_delta: text,
    });
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
  const ctx: ToolExecutionContext = {
    db: params.db,
    sessionId: params.sessionId,
    messageId: params.messageId,
    projectPath: params.projectPath,
    projectConfig: params.projectConfig,
    webContents: params.webContents,
    client,
    delegationDepth: 0,
  };

  const systemPrompt = buildSystemPrompt(params);
  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
  ];

  let fullText = "";
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { text, toolCalls } = await runChatRound(client, model, messages, tools, ctx);
      fullText += text;

      if (toolCalls.length === 0) {
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
  } finally {
    await managedMcpBridge?.close();
  }

  throw new Error(`Ollama tool loop exceeded ${MAX_TOOL_ROUNDS} rounds`);
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
