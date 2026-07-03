import type { AgentInfo } from "../../src/types/index";
import { getApiKey } from "../config";
import { TurnEmitter } from "./turn-emitter";
import { createCodexItemSink, fromAppServerItem, type NormalizedCodexItem } from "./codex-item-mapper";
import {
  CodexAppServerClient,
  spawnAppServerConnector,
  type AppServerConnector,
  type AppServerThreadOptions,
} from "./codex-app-server";
import { resolveCodexApproval } from "./codex-approval-bridge";
import { providerSessionStore } from "./provider-session-store";
import { buildSkillsContext } from "./skills";
import { buildMemoryContext } from "./memory";
import { readAgentFileSystemPrompt } from "./claude";
import { createNativeTranscriptRecorder, type NativeTranscriptRecorder } from "../native-transcript";
import { getDisabledMcpServers } from "../sessions";
import { loadManagedMcpServers, toCodexMcpServers } from "../mcp/managed";
import type { Database } from "better-sqlite3";
import type { AgentProvider, AgentProviderParams } from "./provider";
import type {
  Codex,
  CodexOptions,
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  SandboxMode,
  ApprovalMode,
} from "@openai/codex-sdk";

type CodexConfig = CodexOptions["config"];
type CodexFactory = (options: CodexOptions) => Codex;

// ─────────────────────────────────────────────────────────────────────────────
// Codex provider — backed by `@openai/codex-sdk`.
//
// Unlike the other providers, Codex is NOT an HTTP client: it spawns the Codex
// CLI binary (resolved from the bundled `@openai/codex-<platform>` package or
// `CODEX_CLI_PATH`) and runs Codex as a self-driving coding agent that executes
// its own tools (shell, file edits, MCP) inside its own sandbox. We reflect the
// `item.*` events it streams onto the timeline + trace transcript rather than
// routing tool calls through `runGatedTool`. AIchemist-managed MCP servers are
// injected via the thread `config` (Codex's `mcp_servers`), respecting the
// per-session disable set; Codex then emits `mcp_tool_call` items we reflect.
//
// Two transports, chosen per turn (see runViaExec / runViaAppServer):
//   - exec (`@openai/codex-sdk`): one-shot, no interactive approval callbacks.
//     Used for noTools / nonInteractive turns and as the app-server fallback.
//   - app-server (`codex-app-server.ts`): long-running JSON-RPC; used for
//     interactive turns so `on-request` approvals bridge to AIchemist's approval
//     UI (`codex-approval-bridge.ts`). See docs/plans/2026-06-29-codex-approval-bridging-spike.md.
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MODELS_TIMEOUT_MS = 5_000;
const PROBE_CACHE_TTL_MS = 30_000;
const CODEX_MODEL_PREFIXES = ["gpt-", "o1", "o3"] as const;

let codexInstance: Codex | null = null;
let codexFactory: CodexFactory | null = null;
let appServerConnectorOverride: AppServerConnector | null = null;
let fetchImpl: typeof fetch = (...args) => fetch(...args);
let probeCache: { result: { ok: boolean; reason?: string; durationMs?: number }; timestamp: number } | null =
  null;

function getConfiguredOpenAiApiKey(): string | null {
  const apiKey = getApiKey("openai")?.trim() ?? "";
  return apiKey.length > 0 ? apiKey : null;
}

/**
 * Build a Codex client for this turn. The MCP `config` varies per session (the
 * per-session disable set), and `new Codex()` only stores options (the CLI is
 * spawned per `runStreamed`), so we construct fresh per turn rather than caching
 * a singleton — the dynamic SDK import is module-cached, so this is cheap.
 */
async function getCodex(config?: CodexConfig): Promise<Codex> {
  if (codexInstance) return codexInstance; // direct client injection (test seam)

  const apiKey = getConfiguredOpenAiApiKey();
  if (!apiKey) {
    throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY in ~/.aichemist/.env");
  }

  const options: CodexOptions = {
    apiKey,
    baseUrl: configuredOpenAiBaseUrl(),
    codexPathOverride: process.env.CODEX_CLI_PATH?.trim() || undefined,
    ...(config ? { config } : {}),
  };

  if (codexFactory) return codexFactory(options);

  // Lazy-load the SDK so the (native-binary-backed) module isn't imported until
  // a Codex turn actually runs.
  const { Codex } = await import("@openai/codex-sdk");
  return new Codex(options);
}

/**
 * Build the Codex `config` carrying AIchemist-managed MCP servers for this
 * session, honoring the per-session disable set. Returns `undefined` when there
 * are no servers to inject (so the CLI keeps its own defaults). Codex re-reads
 * `--config` on every spawn, so toggling a server takes effect next turn with no
 * resume-invalidation needed (unlike Copilot).
 */
function buildCodexMcpConfig(db: Database, sessionId: string): CodexConfig | undefined {
  const managed = loadManagedMcpServers({
    excludeNames: new Set(getDisabledMcpServers(db, sessionId)),
  });
  const mcpServers = toCodexMcpServers(managed);
  if (Object.keys(mcpServers).length === 0) return undefined;
  return { mcp_servers: mcpServers } as CodexConfig;
}

/**
 * The configured `OPENAI_BASE_URL` override (proxy/enterprise), normalized
 * without a trailing slash so `${base}/models` never double-slashes. Returns
 * `undefined` when unset, so the SDK keeps its own default.
 */
function configuredOpenAiBaseUrl(): string | undefined {
  const raw = process.env.OPENAI_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

/** OpenAI API base for `/models` — the override (normalized) or the default. */
function resolveOpenAiBaseUrl(): string {
  return configuredOpenAiBaseUrl() ?? OPENAI_API_BASE_URL;
}

async function fetchModelsResponse(apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
  try {
    return await fetchImpl(`${resolveOpenAiBaseUrl()}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ── Model listing ─────────────────────────────────────────────────────────────

async function listCodexModels(): Promise<Array<{ id: string; name: string }>> {
  try {
    const apiKey = getConfiguredOpenAiApiKey();
    if (!apiKey) return [];

    const response = await fetchModelsResponse(apiKey);
    if (!response.ok) return [];

    const data = (await response.json()) as { data: Array<{ id: string; owned_by?: string }> };
    return data.data
      .filter((m) => CODEX_MODEL_PREFIXES.some((prefix) => m.id.startsWith(prefix)))
      .map((m) => ({ id: m.id, name: m.id }));
  } catch {
    return [];
  }
}

// ── Turn helpers ────────────────────────────────────────────────────────────

type CodexAgentPrompt = ReturnType<typeof readAgentFileSystemPrompt>;

/**
 * Compose the skills / agent-body / project-memory context. Codex has no
 * system-prompt parameter (it uses its own config), so this is prepended to the
 * turn input as a preamble when non-empty.
 */
function buildSystemPreamble(params: AgentProviderParams, agentPrompt: CodexAgentPrompt): string {
  const skillsContext = buildSkillsContext(params.skills ?? [], params.projectPath);
  const memoryContext = buildMemoryContext(params.projectPath, { includeToolGuidance: false });
  const agentBody = agentPrompt?.body ?? "";
  return [agentBody, skillsContext, memoryContext]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function resolveModelForTurn(params: AgentProviderParams, agentPrompt: CodexAgentPrompt): string | undefined {
  const override = agentPrompt?.model?.trim();
  if (override) return override;
  const configured = params.projectConfig.model?.trim();
  // Omit the model so Codex falls back to the user's configured default rather
  // than hardcoding a model id that may not exist for their account.
  return configured && configured.length > 0 ? configured : undefined;
}

/**
 * Map AIchemist turn flags onto Codex's sandbox + approval policy.
 *
 * - `noTools` (text-only generation, e.g. PR drafts): read-only, never approve.
 * - `nonInteractive` (autonomous workflow): write in workspace, never prompt.
 * - interactive default: write in workspace; `on-failure` avoids hanging on the
 *   non-interactive transport (full interactive approval bridging is #128).
 */
function resolveSandboxPolicy(params: AgentProviderParams): {
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
} {
  if (params.noTools) return { sandboxMode: "read-only", approvalPolicy: "never" };
  if (params.nonInteractive) return { sandboxMode: "workspace-write", approvalPolicy: "never" };
  return { sandboxMode: "workspace-write", approvalPolicy: "on-failure" };
}

/**
 * Render an MCP tool-call result as readable text for the timeline/traces.
 * Prefers the raw string (text content blocks or a string `structured_content`)
 * and only JSON-stringifies genuinely structured (non-string) results — so plain
 * text isn't wrapped in quotes with escaped newlines.
 */
function renderMcpToolOutput(item: Extract<ThreadItem, { type: "mcp_tool_call" }>): string {
  if (item.error?.message) return item.error.message;

  const structured = item.result?.structured_content;
  if (typeof structured === "string") return structured;

  const content = item.result?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        const value = (block as { text?: unknown }).text;
        return typeof value === "string" ? value : null;
      })
      .filter((t): t is string => t !== null)
      .join("\n");
    if (text) return text;
  }

  const fallback = structured ?? content;
  return fallback === undefined || fallback === null ? "" : JSON.stringify(fallback);
}

/** A short, human-readable label + output for a Codex tool item, for the timeline/traces. */
function describeToolItem(
  item: ThreadItem,
): { name: string; args: Record<string, unknown>; output: string; isError: boolean } | null {
  switch (item.type) {
    case "command_execution":
      return {
        name: "execute_bash",
        args: { command: item.command },
        output: item.aggregated_output ?? "",
        isError: item.status === "failed",
      };
    case "file_change":
      return {
        name: "file_change",
        args: { changes: item.changes },
        output: item.changes.map((c) => `${c.kind} ${c.path}`).join("\n"),
        isError: item.status === "failed",
      };
    case "mcp_tool_call":
      return {
        name: `${item.server}.${item.tool}`,
        args: (item.arguments ?? {}) as Record<string, unknown>,
        output: renderMcpToolOutput(item),
        isError: item.status === "failed" || !!item.error,
      };
    case "web_search":
      return { name: "web_search", args: { query: item.query }, output: item.query, isError: false };
    default:
      return null;
  }
}

/**
 * Adapt an exec-transport `ThreadItem` to the transport-agnostic
 * {@link NormalizedCodexItem} the shared item sink consumes. The app-server
 * transport (#128, slice 4) adds its own adapter onto the same shape.
 */
function fromSdkThreadItem(item: ThreadItem): NormalizedCodexItem {
  if (item.type === "agent_message") return { kind: "message", text: item.text };
  if (item.type === "reasoning") return { kind: "reasoning", text: item.text };
  const desc = describeToolItem(item);
  if (!desc) return { kind: "ignored" };
  const tool: Extract<NormalizedCodexItem, { kind: "tool" }> = {
    kind: "tool",
    id: item.id,
    name: desc.name,
    args: desc.args,
    output: desc.output,
    isError: desc.isError,
  };
  if (item.type === "file_change") {
    tool.fileChanges = item.changes.map((c) => ({
      path: c.path,
      operation: c.kind === "delete" ? "delete" : "write",
    }));
  }
  return tool;
}

// ── Turn execution (two transports) ─────────────────────────────────────────────

/** The per-turn context shared by both transport paths. */
interface TurnRunContext {
  params: AgentProviderParams;
  db: Database;
  sessionId: string;
  projectPath: string;
  emitter: TurnEmitter;
  recorder: NativeTranscriptRecorder | null;
  itemSink: ReturnType<typeof createCodexItemSink>;
  model: string | undefined;
  input: string;
  codexConfig: CodexConfig | undefined;
  persistThread: boolean;
  resumeId: string | null;
}

/**
 * Run the turn via the one-shot `codex exec` SDK transport (the original path).
 * Used for noTools / nonInteractive turns and as the app-server fallback.
 */
async function runViaExec(ctx: TurnRunContext): Promise<string> {
  const { db, sessionId, projectPath, emitter, recorder, itemSink, model, input, codexConfig, persistThread, resumeId } = ctx;
  const codex = await getCodex(codexConfig);
  const { sandboxMode, approvalPolicy } = resolveSandboxPolicy(ctx.params);
  const threadOptions: ThreadOptions = {
    model,
    sandboxMode,
    approvalPolicy,
    workingDirectory: projectPath,
    // The project may not be a git repo; don't let Codex refuse to start.
    skipGitRepoCheck: true,
  };
  const thread: Thread = resumeId
    ? codex.resumeThread(resumeId, threadOptions)
    : codex.startThread(threadOptions);

  let fullText = "";
  try {
    const { events } = await thread.runStreamed(input);
    for await (const event of events as AsyncGenerator<ThreadEvent>) {
      switch (event.type) {
        case "thread.started":
          if (persistThread) {
            providerSessionStore.set(db, sessionId, "codex", { threadId: event.thread_id });
          }
          break;
        case "item.started":
          itemSink.started(fromSdkThreadItem(event.item));
          break;
        case "item.completed":
          fullText += itemSink.completed(fromSdkThreadItem(event.item));
          break;
        case "turn.completed":
          emitter.usage({
            input_tokens: event.usage.input_tokens,
            output_tokens: event.usage.output_tokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: event.usage.cached_input_tokens,
          });
          recorder?.usage({
            input: event.usage.input_tokens,
            output: event.usage.output_tokens,
            cacheRead: event.usage.cached_input_tokens,
            cacheCreation: 0,
          });
          break;
        case "turn.failed":
          throw new Error(event.error.message);
        case "error":
          throw new Error(event.message);
      }
    }
    // The thread id is also populated on the Thread after the first turn; back-stop
    // the persistence in case no `thread.started` event was observed on resume.
    if (persistThread && thread.id) {
      providerSessionStore.set(db, sessionId, "codex", { threadId: thread.id });
    }
    recorder?.turnEnd("success");
  } catch (err) {
    recorder?.turnEnd("error");
    throw err;
  }
  return fullText;
}

/** Build the app-server client for a turn (connector injectable for tests). */
function buildAppServerClient(ctx: TurnRunContext): CodexAppServerClient {
  const connector =
    appServerConnectorOverride ??
    spawnAppServerConnector({
      // Bundled-binary resolution is the same concern as the SDK path (#140);
      // fall back to PATH. A missing binary fails startup → we fall back to exec.
      binaryPath: process.env.CODEX_CLI_PATH?.trim() || "codex",
      apiKey: getConfiguredOpenAiApiKey() ?? "",
      baseUrl: configuredOpenAiBaseUrl(),
      cwd: ctx.projectPath,
    });
  const approvalCtx = {
    sessionId: ctx.sessionId,
    config: ctx.params.projectConfig,
    webContents: ctx.params.webContents,
    nonInteractive: !!ctx.params.nonInteractive,
  };
  return new CodexAppServerClient(connector, (req) => resolveCodexApproval(req, approvalCtx));
}

/**
 * Bring up the app-server client and resume/start the thread. Returns `null`
 * (so the caller falls back to exec) if the server can't be brought up —
 * construction/spawn throw, initialize, or thread start/resume all count as
 * startup failures. Client construction is inside the try so a synchronous
 * spawn failure (e.g. a sandbox blocking `spawn`) also falls back rather than
 * crashing the turn.
 */
async function startAppServerTurn(
  ctx: TurnRunContext,
): Promise<{ client: CodexAppServerClient; threadId: string } | null> {
  let client: CodexAppServerClient | null = null;
  try {
    client = buildAppServerClient(ctx);
    await client.initialize();
    const threadOptions: AppServerThreadOptions = {
      model: ctx.model,
      cwd: ctx.projectPath,
      // Interactive: prompt on request (the whole point of this transport).
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
      config: ctx.codexConfig as Record<string, unknown> | undefined,
    };
    const threadId = ctx.resumeId
      ? await client.resumeThread(ctx.resumeId, threadOptions)
      : await client.startThread(threadOptions);
    return { client, threadId };
  } catch (err) {
    client?.close();
    console.warn(`[codex] app-server unavailable, falling back to exec transport: ${String(err)}`);
    return null;
  }
}

/**
 * Run the turn via the long-running `codex app-server` transport, bridging its
 * on-request approvals to AIchemist's approval UI. Returns `{ fallback: true }`
 * when the server can't be brought up so the caller can retry on exec; a failure
 * *mid-turn* (after streaming starts) is a real error and propagates.
 */
async function runViaAppServer(ctx: TurnRunContext): Promise<{ fallback: true } | { fallback: false; text: string }> {
  const { db, sessionId, emitter, recorder, itemSink, input, persistThread } = ctx;
  const startup = await startAppServerTurn(ctx);
  if (!startup) return { fallback: true };
  const { client, threadId } = startup;

  try {
    if (persistThread) providerSessionStore.set(db, sessionId, "codex", { threadId });
    let fullText = "";
    for await (const event of client.runTurn(threadId, input)) {
      switch (event.type) {
        case "item.started":
          itemSink.started(fromAppServerItem(event.item));
          break;
        case "item.completed":
          fullText += itemSink.completed(fromAppServerItem(event.item));
          break;
        case "turn.completed":
          emitAppServerUsage(event.usage, emitter, recorder);
          break;
        case "turn.failed":
          throw new Error(event.error.message);
        // turn.started / item.updated carry nothing the sink needs.
      }
    }
    recorder?.turnEnd("success");
    return { fallback: false, text: fullText };
  } catch (err) {
    recorder?.turnEnd("error");
    throw err;
  } finally {
    client.close();
  }
}

/** Map an app-server usage payload (best-effort field names) onto the emitter + recorder. */
function emitAppServerUsage(
  usage: unknown,
  emitter: TurnEmitter,
  recorder: NativeTranscriptRecorder | null,
): void {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const input = num(u.input_tokens ?? u.input);
  const output = num(u.output_tokens ?? u.output);
  const cacheRead = num(u.cached_input_tokens ?? u.cached ?? u.cache_read_input_tokens);
  emitter.usage({
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
  });
  recorder?.usage({ input, output, cacheRead, cacheCreation: 0 });
}

// ── Provider implementation ────────────────────────────────────────────────────

export const codexProvider: AgentProvider = {
  async run(params: AgentProviderParams): Promise<string> {
    const { db, sessionId, projectPath, webContents, noTools } = params;

    const emitter = new TurnEmitter(webContents, sessionId);
    const agentPrompt = params.agent ? readAgentFileSystemPrompt(params.agent) : null;
    const model = resolveModelForTurn(params, agentPrompt);
    const input = buildTurnInput(params, agentPrompt);
    // Inject AIchemist-managed MCP servers (respecting the per-session disable
    // set) so Codex can call them; it surfaces them as `mcp_tool_call` items,
    // already reflected onto the timeline/traces. noTools turns get none.
    const codexConfig = noTools ? undefined : buildCodexMcpConfig(db, sessionId);

    // Resume the persisted Codex thread, or start a fresh one. `noTools` turns
    // (skipPersistence — e.g. PR-draft generation) run a throwaway thread and
    // must NOT read or write provider_state: otherwise a discarded turn's
    // ephemeral/read-only thread state would leak into later normal turns.
    const persistThread = !noTools;
    const prior = persistThread ? providerSessionStore.get(db, sessionId, "codex") : null;
    const resumeId = prior?.threadId ?? null;

    // noTools turns (PR-draft generation) are not recorded — matches the other providers.
    const recorder: NativeTranscriptRecorder | null = noTools
      ? null
      : createNativeTranscriptRecorder(sessionId, "codex");
    recorder?.turnStart(model);

    // Shared reflector: normalizes each Codex item and drives the timeline +
    // transcript. Both transports feed the same sink.
    const itemSink = createCodexItemSink({ emitter, recorder, projectPath });

    const ctx: TurnRunContext = {
      params,
      db,
      sessionId,
      projectPath,
      emitter,
      recorder,
      itemSink,
      model,
      input,
      codexConfig,
      persistThread,
      resumeId,
    };

    // Interactive turns use the long-running app-server transport so Codex's
    // on-request approvals bridge to AIchemist's approval UI. noTools /
    // nonInteractive turns (no user watching, or read-only) keep the one-shot
    // exec transport. If the app-server can't come up, fall back to exec so an
    // interactive turn still runs (degraded to the on-failure approval policy).
    const useAppServer = !noTools && !params.nonInteractive;
    if (useAppServer) {
      const result = await runViaAppServer(ctx);
      if (!result.fallback) return result.text;
    }
    return runViaExec(ctx);
  },

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    return listCodexModels();
  },

  async listAgents(_projectPath: string): Promise<AgentInfo[]> {
    // Codex sessions select agents from the shared Claude agent files (see
    // AgentPickerButton); the provider itself exposes no built-in agents.
    return [];
  },

  async probe(opts?: { force?: boolean }): Promise<{ ok: boolean; reason?: string; durationMs?: number }> {
    if (!opts?.force && probeCache && Date.now() - probeCache.timestamp <= PROBE_CACHE_TTL_MS) {
      return probeCache.result;
    }

    let result: { ok: boolean; reason?: string; durationMs?: number };
    const apiKey = getConfiguredOpenAiApiKey();
    if (!apiKey) {
      result = { ok: false, reason: "OpenAI API key not configured", durationMs: 0 };
      probeCache = { result, timestamp: Date.now() };
      return result;
    }

    const start = Date.now();
    try {
      const response = await fetchModelsResponse(apiKey);
      const durationMs = Date.now() - start;
      if (response.ok) {
        result = { ok: true, durationMs };
      } else if (response.status === 401 || response.status === 403) {
        result = { ok: false, reason: "Invalid OpenAI API key", durationMs };
      } else {
        result = { ok: false, reason: `OpenAI API error: ${response.status}`, durationMs };
      }
    } catch (error) {
      const durationMs = Date.now() - start;
      if (error instanceof Error && error.name === "AbortError") {
        result = { ok: false, reason: "OpenAI API timeout", durationMs };
      } else {
        result = { ok: false, reason: String(error), durationMs };
      }
    }
    probeCache = { result, timestamp: Date.now() };
    return result;
  },

  async stop(): Promise<void> {
    codexInstance = null;
    probeCache = null;
    providerSessionStore.reset();
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build the turn input, prepending the composed system preamble when present. */
function buildTurnInput(params: AgentProviderParams, agentPrompt: CodexAgentPrompt): string {
  const preamble = buildSystemPreamble(params, agentPrompt);
  return preamble ? `${preamble}\n\n${params.prompt}` : params.prompt;
}

// ── Test seams ──────────────────────────────────────────────────────────────

export function _setCodexForTests(codex: Codex | null): void {
  codexInstance = codex;
}

/**
 * Inject a factory invoked with the resolved `CodexOptions` (including the MCP
 * `config`) so tests can assert what reaches the SDK constructor. Takes effect
 * only when no direct client is injected via `_setCodexForTests`.
 */
export function _setCodexFactoryForTests(factory: CodexFactory | null): void {
  codexFactory = factory;
}

/**
 * Inject the app-server connector so tests can drive a fake peer (no binary
 * spawn) and simulate item streaming + approval requests. When unset, an
 * interactive turn spawns the real `codex app-server` binary.
 */
export function _setAppServerConnectorForTests(connector: AppServerConnector | null): void {
  appServerConnectorOverride = connector;
}

export function _setFetchForTests(impl: typeof fetch | null): void {
  fetchImpl = impl ?? ((...args) => fetch(...args));
}

export function _resetProbeCacheForTests(): void {
  probeCache = null;
}
