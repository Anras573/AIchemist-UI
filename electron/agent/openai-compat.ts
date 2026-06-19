/**
 * OpenAI-compatible provider.
 *
 * Runs turns against user-configured OpenAI-compatible endpoints (LM Studio,
 * vLLM, llama.cpp, Together, …) defined in `~/.aichemist/openai-providers.json`
 * (see electron/openai-endpoints.ts). Model ids are composite —
 * `<endpoint>/<modelId>` — so one provider id covers any number of endpoints.
 *
 * Like the Ollama provider there is no SDK session state: every turn replays
 * the full message history from SQLite. The tool loop is driven by the AI
 * SDK's `streamText` with `stopWhen: stepCountIs(...)`; every tool execution
 * goes through the shared approval gate (`runGatedTool`), so persistence and
 * SESSION_TOOL_CALL / SESSION_TOOL_RESULT events work like the other providers.
 */
import type { Database } from "better-sqlite3";
import { dynamicTool, jsonSchema, stepCountIs, streamText, tool } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

import { buildSkillsContext } from "./skills";
import { readAgentFileSystemPrompt } from "./claude";
import { requestQuestion } from "./question";
import { loadManagedMcpServers, createManagedMcpBridge } from "../mcp";
import type { ManagedMcpBridge } from "../mcp";
import { getDisabledMcpServers, loadToolCallsForMessage } from "../sessions";
import { runGatedTool } from "./tool-gate";
import { TurnEmitter, emitToolRoundLimitNotice } from "./turn-emitter";
import { readMaxToolRounds } from "../settings";
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
import {
  formatCompositeModelId,
  parseCompositeModelId,
  readOpenAiEndpoints,
} from "../openai-endpoints";
import type { OpenAiEndpointEntry, OpenAiEndpointsMap } from "../openai-endpoints";

export const OPENAI_COMPAT_NO_ENDPOINTS_ERROR =
  "No OpenAI-compatible endpoints configured. Add one in Settings → Providers.";
export const OPENAI_COMPAT_NO_MODELS_ERROR =
  "No models available from the configured OpenAI-compatible endpoints. Check the endpoints in Settings → Providers or configure a model in Project Settings.";

const OPENAI_COMPAT_SYSTEM_PROMPT = [
  "You are AIchemist, a coding assistant running inside a desktop app.",
  "Use the available tools to inspect and modify the project, run commands, fetch URLs, and ask the user questions when needed.",
  "Never invent file contents or command output. If you need more context, use a tool.",
  "When you need clarification, use ask_user instead of asking in plain text.",
].join(" ");

const LIST_MODELS_TIMEOUT_MS = 5_000;
const PROBE_CACHE_TTL_MS = 30_000;

interface ToolContext {
  db: Database;
  sessionId: string;
  messageId: string;
  projectPath: string;
  projectConfig: AgentProviderParams["projectConfig"];
  emitter: TurnEmitter;
  recorder: NativeTranscriptRecorder | null;
}

// ── Test seams ────────────────────────────────────────────────────────────────

let fetchImpl: typeof fetch = (...args) => fetch(...args);
export function _setFetch(impl: typeof fetch | null): void {
  fetchImpl = impl ?? ((...args) => fetch(...args));
}

type ClientFactory = (endpointName: string, entry: OpenAiEndpointEntry) => (modelId: string) => LanguageModel;

const defaultClientFactory: ClientFactory = (endpointName, entry) => {
  const provider = createOpenAICompatible({
    name: endpointName,
    baseURL: entry.baseURL,
    ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
    ...(entry.headers ? { headers: entry.headers } : {}),
    ...(entry.queryParams ? { queryParams: entry.queryParams } : {}),
    includeUsage: true,
  });
  return (modelId) => provider(modelId);
};

let clientFactory: ClientFactory = defaultClientFactory;
export function _setClientFactory(factory: ClientFactory | null): void {
  clientFactory = factory ?? defaultClientFactory;
}

// ── Model listing ─────────────────────────────────────────────────────────────

/** `GET {baseURL}/models` — the standard OpenAI model-listing endpoint. */
async function fetchEndpointModels(
  endpointName: string,
  entry: OpenAiEndpointEntry,
): Promise<Array<{ id: string; name: string }>> {
  const url = new URL(`${entry.baseURL.replace(/\/+$/, "")}/models`);
  for (const [key, value] of Object.entries(entry.queryParams ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {
    ...(entry.apiKey ? { Authorization: `Bearer ${entry.apiKey}` } : {}),
    ...(entry.headers ?? {}),
  };
  // Abort the request (not just the await) on timeout so hung endpoints don't
  // leak in-flight sockets across repeated probes / model listings.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${endpointName} /models timed out after ${LIST_MODELS_TIMEOUT_MS} ms`)),
    LIST_MODELS_TIMEOUT_MS,
  );
  try {
    const res = await fetchImpl(url.toString(), { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${endpointName}: GET /models returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> } | Array<{ id?: unknown }>;
    const items = Array.isArray(body) ? body : body.data ?? [];
    return items
      .map((m) => {
        const id = typeof m?.id === "string" ? m.id.trim() : "";
        return id ? { id: formatCompositeModelId(endpointName, id), name: id } : null;
      })
      .filter((m): m is { id: string; name: string } => m !== null);
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort aggregation across all endpoints — one dead endpoint doesn't hide the rest. */
async function collectEndpointModels(
  endpoints: OpenAiEndpointsMap,
): Promise<{ models: Array<{ id: string; name: string }>; errors: string[] }> {
  const models: Array<{ id: string; name: string }> = [];
  const errors: string[] = [];
  await Promise.all(
    Object.entries(endpoints).map(async ([name, entry]) => {
      try {
        models.push(...(await fetchEndpointModels(name, entry)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        console.warn(`[openai-compat] Failed to list models for "${name}": ${message}`);
      }
    }),
  );
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, errors };
}

export async function getOpenAiCompatModels(): Promise<Array<{ id: string; name: string }>> {
  const { models } = await collectEndpointModels(readOpenAiEndpoints());
  return models;
}

// ── Availability probe ────────────────────────────────────────────────────────

let probeCache: { result: { ok: boolean; reason?: string; durationMs?: number }; timestamp: number } | null = null;

export function _resetOpenAiCompatProbeCache(): void {
  probeCache = null;
}

async function probeOpenAiCompat(opts?: { force?: boolean }): Promise<{ ok: boolean; reason?: string; durationMs?: number }> {
  if (!opts?.force && probeCache && Date.now() - probeCache.timestamp <= PROBE_CACHE_TTL_MS) {
    return probeCache.result;
  }

  let result: { ok: boolean; reason?: string; durationMs?: number };
  try {
    const endpoints = readOpenAiEndpoints();
    if (Object.keys(endpoints).length === 0) {
      result = { ok: false, reason: OPENAI_COMPAT_NO_ENDPOINTS_ERROR, durationMs: 0 };
    } else {
      const start = Date.now();
      const { models, errors } = await collectEndpointModels(endpoints);
      const durationMs = Date.now() - start;
      result =
        models.length > 0
          ? { ok: true, durationMs }
          : { ok: false, reason: errors[0] ?? "Configured endpoints returned no models", durationMs };
    }
  } catch (err) {
    // Never throw — probeAll() awaits every provider with Promise.all, so a
    // rejection here would mark *all* providers unavailable. Convert an
    // unexpected failure (e.g. a config read I/O error) into a not-ok result
    // for this provider only.
    result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  probeCache = { result, timestamp: Date.now() };
  return result;
}

// ── Endpoint / model resolution ───────────────────────────────────────────────

async function resolveEndpointAndModel(
  endpoints: OpenAiEndpointsMap,
  configuredModel?: string,
): Promise<{ endpointName: string; entry: OpenAiEndpointEntry; modelId: string }> {
  const names = Object.keys(endpoints);
  if (names.length === 0) throw new Error(OPENAI_COMPAT_NO_ENDPOINTS_ERROR);

  const explicit = configuredModel?.trim();
  if (explicit) {
    const parsed = parseCompositeModelId(explicit);
    if (parsed && endpoints[parsed.endpointName]) {
      return { endpointName: parsed.endpointName, entry: endpoints[parsed.endpointName], modelId: parsed.modelId };
    }
    // Bare model id (or a composite whose prefix is actually part of the model
    // id, e.g. "meta-llama/Llama-3-70b") — unambiguous only with one endpoint.
    if (names.length === 1) {
      return { endpointName: names[0], entry: endpoints[names[0]], modelId: explicit };
    }
    throw new Error(
      `Model "${explicit}" does not reference a configured endpoint. Use "<endpoint>/<model>" with one of: ${names.join(", ")}`,
    );
  }

  const { models } = await collectEndpointModels(endpoints);
  const first = models[0];
  if (!first) throw new Error(OPENAI_COMPAT_NO_MODELS_ERROR);
  const parsed = parseCompositeModelId(first.id)!;
  return { endpointName: parsed.endpointName, entry: endpoints[parsed.endpointName], modelId: parsed.modelId };
}

/**
 * Match an agent's `model:` frontmatter override against the listed endpoint
 * models. Accepts the composite `<endpoint>/<model>` form (matched exactly,
 * unambiguous by construction) or a bare model id (matched against every
 * endpoint's model list). Returns a discriminated result:
 *
 * - `matched` — exactly one endpoint serves the model.
 * - `ambiguous` — a bare id is served by multiple endpoints; the caller should
 *   fall back and tell the user to disambiguate with the composite form.
 * - `none` — absent override or no endpoint serves the model.
 */
export type AgentModelMatch =
  | { kind: "matched"; endpointName: string; entry: OpenAiEndpointEntry; modelId: string }
  | { kind: "ambiguous"; endpoints: string[] }
  | { kind: "none" };

export function pickAgentModelTarget(
  override: string | undefined,
  models: Array<{ id: string }>,
  endpoints: OpenAiEndpointsMap,
): AgentModelMatch {
  const wanted = override?.trim();
  if (!wanted) return { kind: "none" };
  // Composite form: the listed ids are themselves "<endpoint>/<model>", so an
  // exact match covers "<endpoint>/<model>" overrides (including model ids that
  // contain slashes) and is unambiguous by construction.
  const exact = models.find((m) => m.id === wanted);
  if (exact) {
    const parsed = parseCompositeModelId(exact.id);
    if (parsed && endpoints[parsed.endpointName]) {
      return { kind: "matched", endpointName: parsed.endpointName, entry: endpoints[parsed.endpointName], modelId: parsed.modelId };
    }
  }
  // Bare model id: collect every configured endpoint whose model list contains
  // it. More than one means the override is ambiguous.
  const matchedEndpoints = [
    ...new Set(
      models
        .map((m) => parseCompositeModelId(m.id))
        .filter(
          (p): p is { endpointName: string; modelId: string } =>
            !!p && p.modelId === wanted && !!endpoints[p.endpointName],
        )
        .map((p) => p.endpointName),
    ),
  ];
  if (matchedEndpoints.length === 0) return { kind: "none" };
  if (matchedEndpoints.length > 1) return { kind: "ambiguous", endpoints: matchedEndpoints };
  const endpointName = matchedEndpoints[0];
  return { kind: "matched", endpointName, entry: endpoints[endpointName], modelId: wanted };
}

/**
 * Resolve a selected agent's `model:` override to an endpoint target without
 * always hitting the network:
 *
 * - Composite `<endpoint>/<model>` referencing a configured endpoint → resolved
 *   directly (no `/models` call), mirroring how `resolveEndpointAndModel` treats
 *   an explicit composite session model.
 * - Bare model id with exactly one configured endpoint → unambiguous, resolved
 *   directly.
 * - Bare model id with multiple endpoints → ambiguous, so we list models once to
 *   discover which endpoint serves it. If nothing can be listed (all endpoints
 *   unreachable) we can't validate, so we return null *silently* (the
 *   per-endpoint listing failures already warned); a model served by multiple
 *   endpoints, or by none, warns once and falls back.
 *
 * Returns null when the override can't be resolved — the caller then falls back
 * to the session model. Never throws.
 */
async function resolveOverrideTarget(
  endpoints: OpenAiEndpointsMap,
  override: string,
): Promise<{ endpointName: string; entry: OpenAiEndpointEntry; modelId: string } | null> {
  const names = Object.keys(endpoints);
  const parsed = parseCompositeModelId(override);
  if (parsed && endpoints[parsed.endpointName]) {
    return { endpointName: parsed.endpointName, entry: endpoints[parsed.endpointName], modelId: parsed.modelId };
  }
  if (names.length === 1) {
    return { endpointName: names[0], entry: endpoints[names[0]], modelId: override };
  }
  // Bare id with multiple endpoints — the only case that needs discovery.
  const { models } = await collectEndpointModels(endpoints);
  if (models.length === 0) return null; // can't validate; stay silent
  const match = pickAgentModelTarget(override, models, endpoints);
  switch (match.kind) {
    case "matched":
      return { endpointName: match.endpointName, entry: match.entry, modelId: match.modelId };
    case "ambiguous":
      console.warn(
        `[openai-compat] Agent model "${override}" is served by multiple endpoints (${match.endpoints.join(", ")}) — specify the composite "<endpoint>/<model>" form. Falling back to the session model.`,
      );
      return null;
    case "none":
      console.warn(
        `[openai-compat] Agent model "${override}" is not available on any configured endpoint — falling back to the session model`,
      );
      return null;
  }
}

/**
 * Resolve the turn's endpoint + model. A selected agent's `model:` frontmatter
 * takes precedence when it resolves to a configured endpoint; otherwise we fall
 * back to the session/project model resolution. An unresolvable agent model
 * falls back rather than failing the turn.
 */
async function resolveTargetForTurn(
  endpoints: OpenAiEndpointsMap,
  params: AgentProviderParams,
): Promise<{ endpointName: string; entry: OpenAiEndpointEntry; modelId: string }> {
  const override = params.agent ? readAgentFileSystemPrompt(params.agent)?.model?.trim() : undefined;
  // Skip the override path when no endpoints are configured — there is nothing
  // to resolve against, and `resolveEndpointAndModel` will surface the real
  // OPENAI_COMPAT_NO_ENDPOINTS_ERROR.
  if (override && Object.keys(endpoints).length > 0) {
    const picked = await resolveOverrideTarget(endpoints, override);
    if (picked) return picked;
  }
  return resolveEndpointAndModel(endpoints, params.projectConfig.model);
}

// ── System prompt & history ───────────────────────────────────────────────────

function buildSystemPrompt(params: AgentProviderParams): string {
  const skillsContext = buildSkillsContext(params.skills ?? [], params.projectPath);
  const agentBody = params.agent ? readAgentFileSystemPrompt(params.agent)?.body ?? "" : "";
  const parts = [OPENAI_COMPAT_SYSTEM_PROMPT, agentBody, skillsContext];
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "";
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function loadHistory(db: Database, sessionId: string, placeholderMessageId: string): ModelMessage[] {
  const rows = db
    .prepare(
      `SELECT id, role, content
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as Array<{ id: string; role: string; content: string }>;

  const history: ModelMessage[] = [];
  for (const row of rows) {
    if (row.id === placeholderMessageId) continue;
    if (row.role === "user") {
      history.push({ role: "user", content: row.content });
      continue;
    }
    if (row.role !== "assistant") continue;

    const toolCalls = loadToolCallsForMessage(db, row.id);
    if (toolCalls.length === 0) {
      if (row.content) history.push({ role: "assistant", content: row.content });
      continue;
    }

    history.push({
      role: "assistant",
      content: [
        ...(row.content ? [{ type: "text" as const, text: row.content }] : []),
        ...toolCalls.map((call) => ({
          type: "tool-call" as const,
          toolCallId: call.id,
          toolName: call.name,
          input: call.args ?? {},
        })),
      ],
    });
    history.push({
      role: "tool",
      content: toolCalls.map((call) => ({
        type: "tool-result" as const,
        toolCallId: call.id,
        toolName: call.name,
        output: { type: "text" as const, value: stringifyToolResult(call.result) },
      })),
    });
  }
  return history;
}

/**
 * Ensure the turn's prompt is the final user message. The renderer saves the
 * user message before AGENT_SEND, so it is usually already last in history —
 * but it may differ from `prompt` (GitHub-issue context augmentation) or be
 * missing entirely (skipPersistence turns such as PR draft generation).
 */
function withCurrentPrompt(history: ModelMessage[], prompt: string): ModelMessage[] {
  const last = history[history.length - 1];
  if (last && last.role === "user") {
    return [...history.slice(0, -1), { role: "user", content: prompt }];
  }
  return [...history, { role: "user", content: prompt }];
}

// ── Tools ─────────────────────────────────────────────────────────────────────

function runTool(
  ctx: ToolContext,
  name: string,
  args: unknown,
  category: "filesystem" | "shell" | "web" | "custom",
  impl: () => Promise<string>,
): Promise<string> {
  return runGatedTool(ctx, { name, args, category, impl });
}

function makeBuiltinTools(ctx: ToolContext): ToolSet {
  return {
    read_file: tool({
      description: "Read a file from the project and return its text content.",
      inputSchema: z.object({
        path: z.string().describe("Absolute or relative file path"),
      }),
      execute: ({ path }) =>
        runTool(ctx, "read_file", { path }, "filesystem", async () => implReadTextFile(ctx.projectPath, path)),
    }),
    list_directory: tool({
      description: "List the contents of a directory in the project.",
      inputSchema: z.object({
        path: z.string().describe("Absolute or relative directory path"),
      }),
      execute: ({ path }) =>
        runTool(ctx, "list_directory", { path }, "filesystem", async () => implListDirectory(ctx.projectPath, path)),
    }),
    glob: tool({
      description: "Find project files matching a glob pattern.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern relative to the project root"),
      }),
      execute: ({ pattern }) =>
        runTool(ctx, "glob", { pattern }, "filesystem", async () => implGlobFiles(ctx.projectPath, pattern)),
    }),
    write_file: tool({
      description: "Write content to a file, creating parent directories as needed.",
      inputSchema: z.object({
        path: z.string().describe("Absolute or relative file path"),
        content: z.string().describe("Content to write"),
      }),
      execute: ({ path, content }) =>
        runTool(ctx, "write_file", { path, content }, "filesystem", async () => {
          const { result, change } = await implWriteFileWithChange({ path, content }, ctx.projectPath);
          if (change) ctx.emitter.fileChange(change);
          return result;
        }),
    }),
    delete_file: tool({
      description: "Delete a file from the project.",
      inputSchema: z.object({
        path: z.string().describe("Absolute or relative file path"),
      }),
      execute: ({ path }) =>
        runTool(ctx, "delete_file", { path }, "filesystem", async () => {
          const { result, change } = await implDeleteFileWithChange({ path }, ctx.projectPath);
          if (change) ctx.emitter.fileChange(change);
          return result;
        }),
    }),
    execute_bash: tool({
      description: "Execute a shell command and return its output. Always requires approval.",
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        cwd: z.string().optional().describe("Working directory for the command"),
      }),
      execute: ({ command, cwd }) =>
        runTool(ctx, "execute_bash", { command, cwd }, "shell", async () =>
          implExecuteBash({ command, cwd, projectPath: ctx.projectPath }),
        ),
    }),
    web_fetch: tool({
      description: "Fetch a URL via HTTP GET and return its content.",
      inputSchema: z.object({
        url: z.string().describe("URL to fetch"),
      }),
      execute: ({ url }) => runTool(ctx, "web_fetch", { url }, "web", async () => implWebFetch({ url })),
    }),
    ask_user: tool({
      description: "Ask the user a question and wait for the answer before proceeding.",
      inputSchema: z.object({
        question: z.string().describe("The question to ask the user"),
        options: z.array(z.string()).optional().describe("Optional choices to present to the user"),
        placeholder: z.string().optional().describe("Placeholder for free-form input"),
      }),
      execute: ({ question, options, placeholder }) =>
        runTool(ctx, "ask_user", { question, options, placeholder }, "custom", async () =>
          requestQuestion(ctx.emitter.webContents, ctx.sessionId, question, options, placeholder).then(
            (answer) => answer || "(no answer provided)",
          ),
        ),
    }),
  };
}

function makeMcpTools(ctx: ToolContext, bridge: ManagedMcpBridge): ToolSet {
  const out: ToolSet = {};
  for (const def of bridge.tools) {
    const name = def.function.name;
    // Managed MCP tools can do anything, so gate them with the strictest
    // existing approval category instead of treating them as file edits.
    out[name] = dynamicTool({
      description: def.function.description,
      inputSchema: jsonSchema(def.function.parameters as JSONSchema7),
      execute: (input) =>
        runTool(ctx, name, input, "shell", async () =>
          bridge.callTool(name, (input ?? {}) as Record<string, unknown>),
        ),
    });
  }
  return out;
}

// ── Turn execution ────────────────────────────────────────────────────────────

export async function runOpenAiCompatTurn(params: AgentProviderParams): Promise<string> {
  const endpoints = readOpenAiEndpoints();
  const { endpointName, entry, modelId } = await resolveTargetForTurn(endpoints, params);
  const model = clientFactory(endpointName, entry)(modelId);

  const emitter = new TurnEmitter(params.webContents, params.sessionId);
  // noTools turns are text-only generation (e.g. PR draft generation) — skip
  // transcript recording so they don't surface as empty turns in the Traces tab.
  const recorder = params.noTools
    ? null
    : createNativeTranscriptRecorder(params.sessionId, "openai-compatible");
  const ctx: ToolContext = {
    db: params.db,
    sessionId: params.sessionId,
    messageId: params.messageId,
    projectPath: params.projectPath,
    projectConfig: params.projectConfig,
    emitter,
    recorder,
  };

  // When noTools is true (text-only generation turns), skip all tool
  // definitions and MCP bridge startup to prevent any side-effects.
  const managedMcpBridge = params.noTools
    ? null
    : await createManagedMcpBridge(
        loadManagedMcpServers({ excludeNames: new Set(getDisabledMcpServers(params.db, params.sessionId)) }),
        params.projectPath,
      );
  const tools = managedMcpBridge ? { ...makeBuiltinTools(ctx), ...makeMcpTools(ctx, managedMcpBridge) } : undefined;

  const messages = withCurrentPrompt(loadHistory(params.db, params.sessionId, params.messageId), params.prompt);

  // Open the transcript turn only after the throwing setup (bridge/history)
  // succeeds, so a failed setup can't leave an unterminated "running" span.
  recorder?.turnStart(formatCompositeModelId(endpointName, modelId));

  // Only the tool loop needs the cap; text-only (noTools) turns set no
  // `stopWhen` and can't emit a truncation notice, so skip the settings read.
  const maxToolRounds = tools ? readMaxToolRounds() : 0;
  let fullText = "";
  let turnStatus: "success" | "error" = "error";
  // Captured from the final `finish` part. A `tool-calls` reason means the AI
  // SDK halted the multi-step loop at `stepCountIs(maxToolRounds)` while the
  // model still wanted to call tools — i.e. the turn was truncated.
  let finishReason: string | undefined;
  try {
    const result = streamText({
      model,
      system: buildSystemPrompt(params),
      messages,
      ...(tools ? { tools, stopWhen: stepCountIs(maxToolRounds) } : {}),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          fullText += part.text;
          emitter.delta(part.text);
          break;
        case "reasoning-delta":
          emitter.thinkingDelta(part.text);
          recorder?.reasoning(part.text);
          break;
        case "reasoning-end":
          emitter.thinkingDone();
          break;
        case "finish":
          finishReason = part.finishReason;
          emitter.usage({
            input_tokens: part.totalUsage.inputTokens ?? 0,
            output_tokens: part.totalUsage.outputTokens ?? 0,
            cache_read_input_tokens: part.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
            cache_creation_input_tokens: part.totalUsage.inputTokenDetails?.cacheWriteTokens ?? 0,
          });
          recorder?.usage({
            input: part.totalUsage.inputTokens ?? 0,
            output: part.totalUsage.outputTokens ?? 0,
            cacheRead: part.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
            cacheCreation: part.totalUsage.inputTokenDetails?.cacheWriteTokens ?? 0,
          });
          break;
        case "error":
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        default:
          // Tool calls/results are emitted and persisted inside runGatedTool.
          break;
      }
    }
    // The loop stopped on `tool-calls` rather than a natural `stop`: the step
    // cap was hit mid-workflow. Surface the truncation (and keep any partial
    // text) instead of ending silently.
    if (tools && finishReason === "tool-calls") {
      fullText += emitToolRoundLimitNotice(emitter, maxToolRounds);
    }
    turnStatus = "success";
  } finally {
    await managedMcpBridge?.close();
    recorder?.turnEnd(turnStatus);
  }

  return fullText;
}

export const openaiCompatProvider: AgentProvider = {
  run: (params: AgentProviderParams) => runOpenAiCompatTurn(params),
  listModels: () => getOpenAiCompatModels(),
  probe: (opts?: { force?: boolean }) => probeOpenAiCompat(opts),
};
