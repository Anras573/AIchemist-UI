import type { AgentInfo } from "../../src/types/index";
import { getApiKey } from "../config";
import { TurnEmitter } from "./turn-emitter";
import { providerSessionStore } from "./provider-session-store";
import { buildSkillsContext } from "./skills";
import { buildMemoryContext } from "./memory";
import { readAgentFileSystemPrompt } from "./claude";
import { createNativeTranscriptRecorder, type NativeTranscriptRecorder } from "../native-transcript";
import type { AgentProvider, AgentProviderParams } from "./provider";
import type {
  Codex,
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  SandboxMode,
  ApprovalMode,
} from "@openai/codex-sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Codex provider — backed by `@openai/codex-sdk`.
//
// Unlike the other providers, the Codex SDK is NOT an HTTP client: it spawns the
// Codex CLI binary (resolved from the bundled `@openai/codex-<platform>` package
// or `CODEX_CLI_PATH`) and runs Codex as a self-driving coding agent. Codex
// executes its own tools (shell, file edits, MCP) inside its own sandbox, so we
// do NOT route tool calls through `runGatedTool`; instead we configure Codex's
// `sandboxMode` / `approvalPolicy` and reflect the `item.*` events it streams
// onto the timeline + trace transcript.
//
// Approval parity (surfacing Codex's interactive `on-request` approvals through
// AIchemist's approval UI) is intentionally out of scope here and tracked by
// #128 / #127 — the non-interactive `codex exec` transport this SDK uses cannot
// surface interactive approval callbacks. See docs/plans/2026-06-28-codex-parity-plan.md.
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MODELS_TIMEOUT_MS = 5_000;
const PROBE_CACHE_TTL_MS = 30_000;
const CODEX_MODEL_PREFIXES = ["gpt-", "o1", "o3"] as const;

let codexInstance: Codex | null = null;
let fetchImpl: typeof fetch = (...args) => fetch(...args);
let probeCache: { result: { ok: boolean; reason?: string; durationMs?: number }; timestamp: number } | null =
  null;

function getConfiguredOpenAiApiKey(): string | null {
  const apiKey = getApiKey("openai")?.trim() ?? "";
  return apiKey.length > 0 ? apiKey : null;
}

async function getCodex(): Promise<Codex> {
  if (codexInstance) return codexInstance;

  const apiKey = getConfiguredOpenAiApiKey();
  if (!apiKey) {
    throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY in ~/.aichemist/.env");
  }

  // Lazy-load the SDK so the (native-binary-backed) module isn't imported until
  // a Codex turn actually runs.
  const { Codex } = await import("@openai/codex-sdk");
  const baseUrl = process.env.OPENAI_BASE_URL?.trim() || undefined;
  const codexPathOverride = process.env.CODEX_CLI_PATH?.trim() || undefined;
  codexInstance = new Codex({ apiKey, baseUrl, codexPathOverride });
  return codexInstance;
}

async function fetchModelsResponse(apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
  try {
    return await fetchImpl(`${OPENAI_API_BASE_URL}/models`, {
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
        output: item.error?.message ?? JSON.stringify(item.result?.structured_content ?? item.result?.content ?? ""),
        isError: item.status === "failed" || !!item.error,
      };
    case "web_search":
      return { name: "web_search", args: { query: item.query }, output: item.query, isError: false };
    default:
      return null;
  }
}

// ── Provider implementation ────────────────────────────────────────────────────

export const codexProvider: AgentProvider = {
  async run(params: AgentProviderParams): Promise<string> {
    const { db, sessionId, projectPath, webContents, noTools } = params;

    const emitter = new TurnEmitter(webContents, sessionId);
    const codex = await getCodex();

    const agentPrompt = params.agent ? readAgentFileSystemPrompt(params.agent) : null;
    const model = resolveModelForTurn(params, agentPrompt);
    const { sandboxMode, approvalPolicy } = resolveSandboxPolicy(params);

    const threadOptions: ThreadOptions = {
      model,
      sandboxMode,
      approvalPolicy,
      workingDirectory: projectPath,
      // The project may not be a git repo; don't let Codex refuse to start.
      skipGitRepoCheck: true,
    };

    // Resume the persisted Codex thread, or start a fresh one.
    const prior = providerSessionStore.get(db, sessionId, "codex");
    const resumeId = prior?.threadId ?? null;
    const thread: Thread = resumeId
      ? codex.resumeThread(resumeId, threadOptions)
      : codex.startThread(threadOptions);

    // noTools turns (PR-draft generation) are not recorded — matches the other providers.
    const recorder: NativeTranscriptRecorder | null = noTools
      ? null
      : createNativeTranscriptRecorder(sessionId, "codex");
    recorder?.turnStart(model);

    // Codex tool items only carry an `item.started`/`item.completed` pair; track
    // which ids we've already surfaced a tool-call for so we don't double-emit.
    const startedToolIds = new Set<string>();

    const emitToolCall = (item: ThreadItem) => {
      const desc = describeToolItem(item);
      if (!desc || startedToolIds.has(item.id)) return;
      startedToolIds.add(item.id);
      emitter.toolCall(item.id, desc.name, desc.args);
      recorder?.toolCall(item.id, desc.name, desc.args);
    };

    const input = buildTurnInput(params, agentPrompt);

    let fullText = "";
    try {
      const { events } = await thread.runStreamed(input);
      for await (const event of events as AsyncGenerator<ThreadEvent>) {
        switch (event.type) {
          case "thread.started":
            providerSessionStore.set(db, sessionId, "codex", { threadId: event.thread_id });
            break;
          case "item.started":
            emitToolCall(event.item);
            break;
          case "item.completed": {
            const item = event.item;
            if (item.type === "agent_message") {
              fullText += item.text;
              emitter.delta(item.text);
            } else if (item.type === "reasoning") {
              recorder?.reasoning(item.text);
            } else {
              // A tool item — make sure the call was surfaced, then its result.
              emitToolCall(item);
              const desc = describeToolItem(item);
              if (desc) {
                emitter.toolResult(desc.name, desc.output);
                recorder?.toolResult(item.id, desc.output, desc.isError);
              }
            }
            break;
          }
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
      if (thread.id) {
        providerSessionStore.set(db, sessionId, "codex", { threadId: thread.id });
      }
      recorder?.turnEnd("success");
    } catch (err) {
      recorder?.turnEnd("error");
      throw err;
    }

    return fullText;
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

export function _setFetchForTests(impl: typeof fetch | null): void {
  fetchImpl = impl ?? ((...args) => fetch(...args));
}

export function _resetProbeCacheForTests(): void {
  probeCache = null;
}
