/**
 * ACP (Agent Client Protocol) provider.
 *
 * AIchemist-UI is the ACP client. The agent runs as a subprocess (stdio) configured
 * per-project via `ProjectConfig.acp_agent`. We translate ACP `session/update`
 * notifications into the same IPC events Claude/Copilot use, so the rest of the
 * UI is provider-agnostic.
 *
 * Subprocess lifecycle is managed internally — one subprocess per
 * `(projectPath, agentConfigFingerprint)`. Per-AIchemist-session ACP session ids
 * are cached in-memory and persisted to `sessions.acp_session_id` for diagnostics.
 *
 * v1 LIMITATIONS:
 *   - text-only prompts (other ContentBlock types are skipped with a warning)
 *   - no `session/load` replay on resume — every AIchemist session gets a fresh
 *     ACP session on first run() call
 *   - no terminal capability advertised
 *   - no auth flow UI; users must set `acp_agent.auth_method_id` manually
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ChildProcess, spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";

import type { Database } from "better-sqlite3";

import * as CH from "../ipc-channels";
import {
  saveToolCall,
  updateToolCallStatus,
  setAcpSessionId,
} from "../sessions";
import {
  requestApproval,
  requestPermissionChoice,
  requiresApproval,
  type ToolCategory,
} from "./approval";
import { implWriteFileWithChange } from "./tool-impls";
import type { AcpAgentConfig, ProjectConfig } from "../../src/types/index";
import type {
  AgentProvider,
  AgentProviderParams,
} from "./provider";

// SDK is ESM. Lazy-loaded via dynamic import so this module can be required by CJS code.
type AcpSdk = typeof import("@agentclientprotocol/sdk");
let sdkPromise: Promise<AcpSdk> | null = null;
function loadSdk(): Promise<AcpSdk> {
  if (!sdkPromise) sdkPromise = import("@agentclientprotocol/sdk");
  return sdkPromise;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AcpConnectionHandle {
  /** Connection key — `{projectPath}::{fingerprint}`. */
  key: string;
  proc: ChildProcess;
  /** ClientSideConnection — typed as `unknown` because the SDK is loaded lazily. */
  connection: unknown;
  /** authMethods returned by `initialize` — surfaced on auth failures. */
  authMethods: Array<{ id: string; name?: string; description?: string | null }>;
  /** Set when the subprocess exits / a fatal error occurs. */
  closed: boolean;
}

/** Map<connectionKey, handle> — one subprocess per (projectPath × agent config). */
const connections = new Map<string, AcpConnectionHandle>();

/**
 * In-flight `spawnConnection` promises keyed by the same connectionKey. Lets
 * concurrent `getOrCreateConnection` calls for the same (projectPath, agent)
 * share a single subprocess instead of racing and leaking duplicates.
 */
const pendingConnections = new Map<string, Promise<AcpConnectionHandle>>();

/**
 * connectionKey → set of ACP session ids issued by that subprocess. Lets us
 * evict stale entries from `acpSessionIds` and `activeRuntimes` when the
 * subprocess exits, so the next `run()` reissues `newSession`.
 */
const acpSessionsByConnection = new Map<string, Set<string>>();

/**
 * Per-AIchemist-session ACP session id. Cached in memory + persisted to
 * `sessions.acp_session_id` so a fresh app launch can read the prior id for
 * diagnostics (we still always create a new ACP session in v1).
 */
const acpSessionIds = new Map<string, string>();

/**
 * Per-session active "client" — captures the runtime context (db, webContents,
 * sessionId, projectConfig) needed by the long-lived `Client` interface so
 * notification callbacks (which are invoked by the SDK) can route to the
 * currently-running turn.
 *
 * The map is keyed by ACP sessionId. There is at most one active turn per
 * AIchemist session at a time.
 */
interface RuntimeContext {
  db: Database;
  webContents: Electron.WebContents;
  /** AIchemist sessionId (NOT ACP sessionId). */
  aiSessionId: string;
  /** Placeholder messageId so tool_calls can FK-reference. */
  messageId: string;
  projectConfig: ProjectConfig;
  projectPath: string;
  /** Buffered text from agent_message_chunk events; flushed back as the run() return value. */
  buffer: string[];
  /** ACP toolCallId → AIchemist tool_calls.id mapping (we mirror them 1:1). */
  toolCallIds: Set<string>;
}

const activeRuntimes = new Map<string, RuntimeContext>();

// ── Connection key / fingerprint ──────────────────────────────────────────────

function fingerprintAgentConfig(cfg: AcpAgentConfig): string {
  const normalized = JSON.stringify({
    command: cfg.command,
    args: cfg.args ?? [],
    env: cfg.env ?? {},
    cwd: cfg.cwd ?? "",
    authMethodId: cfg.auth_method_id ?? "",
  });
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function connectionKey(projectPath: string, cfg: AcpAgentConfig): string {
  return `${projectPath}::${fingerprintAgentConfig(cfg)}`;
}

// ── Subprocess + connection lifecycle ────────────────────────────────────────

/**
 * Allow-listed env vars passed to the ACP agent subprocess. Anything not on
 * this list (including credentials in `process.env` such as ANTHROPIC_API_KEY,
 * GITHUB_TOKEN, OPENAI_API_KEY, AWS_*, SSH_AUTH_SOCK, etc.) is intentionally
 * withheld so a third-party ACP agent cannot exfiltrate them on startup.
 *
 * Agents that need credentials must opt in explicitly via `cfg.env` per agent.
 */
const AGENT_ENV_ALLOWLIST: readonly string[] = [
  // POSIX
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  // Windows
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "USERPROFILE",
  "USERNAME",
  "TEMP",
  "TMP",
  "COMSPEC",
  "PATHEXT",
];

/** Returns the filtered process env to pass to a spawned ACP agent. Excludes secrets. */
function buildAgentEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (val !== undefined) out[key] = val;
  }
  return out;
}

async function spawnConnection(
  projectPath: string,
  cfg: AcpAgentConfig
): Promise<AcpConnectionHandle> {
  const sdk = await loadSdk();
  const key = connectionKey(projectPath, cfg);

  const cwd = cfg.cwd ?? projectPath;
  const env = { ...buildAgentEnv(), ...(cfg.env ?? {}) };
  const proc = spawn(cfg.command, cfg.args ?? [], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error(`ACP agent failed to start (${cfg.command}): no stdio streams`);
  }

  const input = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
  const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const stream = sdk.ndJsonStream(input, output);

  const handle: AcpConnectionHandle = {
    key,
    proc,
    connection: undefined,
    authMethods: [],
    closed: false,
  };

  // The Client implementation routes per-session notifications via the
  // activeRuntimes map (keyed by ACP sessionId).
  const client = createClient();
  const connection = new sdk.ClientSideConnection(() => client, stream);
  handle.connection = connection;

  proc.on("exit", (code, signal) => {
    handle.closed = true;
    connections.delete(key);
    evictAcpSessionsForConnection(key);
    console.warn(`[acp] agent ${cfg.command} exited (code=${code} signal=${signal}); connection ${key} discarded`);
  });
  proc.on("error", (err) => {
    handle.closed = true;
    connections.delete(key);
    evictAcpSessionsForConnection(key);
    console.error(`[acp] agent ${cfg.command} error:`, err);
  });

  // Initialize handshake.
  const initResult = await connection.initialize({
    protocolVersion: sdk.PROTOCOL_VERSION,
    clientInfo: { name: "AIchemist-UI", version: "0.1.0" },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      // Terminal NOT advertised in v1.
    },
  });

  handle.authMethods = (initResult.authMethods ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
  }));

  connections.set(key, handle);
  return handle;
}

async function getOrCreateConnection(
  projectPath: string,
  cfg: AcpAgentConfig
): Promise<AcpConnectionHandle> {
  const key = connectionKey(projectPath, cfg);
  const existing = connections.get(key);
  if (existing && !existing.closed) return existing;

  // Coalesce concurrent callers onto a single in-flight spawn.
  const inFlight = pendingConnections.get(key);
  if (inFlight) return inFlight;

  const spawnPromise = spawnConnection(projectPath, cfg).finally(() => {
    pendingConnections.delete(key);
  });
  pendingConnections.set(key, spawnPromise);
  return spawnPromise;
}

/**
 * Liveness probe — used by the renderer to decide whether to enable the ACP
 * provider option in the new-session UI. Reuses `getOrCreateConnection` so the
 * subprocess stays warm for the real session that follows; the only failure
 * modes are "command not configured", spawn ENOENT, or `initialize` rejecting
 * within `timeoutMs`.
 */
export async function acpProbe(
  projectPath: string,
  cfg: AcpAgentConfig,
  timeoutMs: number,
): Promise<{ ok: boolean; reason?: string }> {
  if (!cfg.command) {
    return { ok: false, reason: "ACP agent not configured (acp_agent.command is empty)" };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const handle = await new Promise<AcpConnectionHandle>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`ACP probe timed out after ${timeoutMs} ms`)), timeoutMs);
      getOrCreateConnection(projectPath, cfg).then(resolve, reject);
    });
    if (handle.closed) return { ok: false, reason: "ACP subprocess exited during initialize" };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Removes any cached ACP sessionIds (and their runtime contexts) that were
 * issued by the subprocess at `connectionKey`. Called on subprocess exit/error
 * so a stale id is not reused with a freshly-spawned subprocess.
 */
function evictAcpSessionsForConnection(key: string): void {
  const sids = acpSessionsByConnection.get(key);
  if (!sids) return;
  for (const sid of sids) {
    activeRuntimes.delete(sid);
    for (const [aiSessionId, cachedSid] of acpSessionIds.entries()) {
      if (cachedSid === sid) acpSessionIds.delete(aiSessionId);
    }
  }
  acpSessionsByConnection.delete(key);
}

// ── Client implementation ────────────────────────────────────────────────────

function createClient() {
  // The SDK Client interface — only the subset we implement is shown.
  // Loose param typing because the SDK's generated types use null for many fields.
  return {
    async sessionUpdate(params: { sessionId: string; update: any }): Promise<void> {
      const ctx = activeRuntimes.get(params.sessionId);
      if (!ctx) {
        // Notification arrived for a session not currently running — silently drop.
        return;
      }
      handleSessionUpdate(ctx, params.update);
    },

    async requestPermission(params: any): Promise<any> {
      const ctx = activeRuntimes.get(params.sessionId);
      if (!ctx) return { outcome: { outcome: "cancelled" } };

      const optionId = await requestPermissionChoice(
        ctx.webContents,
        ctx.aiSessionId,
        params.toolCall.toolCallId,
        params.toolCall.title ?? params.toolCall.kind ?? "tool",
        params.toolCall.rawInput ?? {},
        (params.options as Array<{ optionId: string; name: string; kind: string }>).map((o) => ({ id: o.optionId, name: o.name, kind: o.kind }))
      );

      if (optionId === null) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    },

    async writeTextFile(params: any): Promise<Record<string, never>> {
      const ctx = activeRuntimes.get(params.sessionId);
      if (!ctx) throw new Error("No active runtime for session");
      await handleAcpWriteFile(ctx, params);
      return {};
    },

    async readTextFile(params: any): Promise<{ content: string }> {
      const ctx = activeRuntimes.get(params.sessionId);
      if (!ctx) throw new Error("No active runtime for session");
      return handleAcpReadFile(ctx, params);
    },
  };
}

// ── Event mapping: session/update → IPC ──────────────────────────────────────

/** Exposed for testing — pure event-mapper logic lives here. */
export function handleSessionUpdate(ctx: RuntimeContext, update: any): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = extractText(update.content);
      if (text) {
        ctx.buffer.push(text);
        ctx.webContents.send(CH.SESSION_DELTA, {
          session_id: ctx.aiSessionId,
          text_delta: text,
        });
      }
      break;
    }

    case "agent_thought_chunk":
      // We do not surface internal thoughts in v1.
      break;

    case "user_message_chunk":
      // Echo of user prompt — no UI surface needed.
      break;

    case "tool_call": {
      const { toolCallId, title, kind, status, rawInput } = update;
      if (ctx.toolCallIds.has(toolCallId)) break; // Idempotent
      ctx.toolCallIds.add(toolCallId);
      const args = (rawInput && typeof rawInput === "object")
        ? (rawInput as Record<string, unknown>)
        : { _raw: rawInput };
      const dbStatus = mapAcpStatus(status ?? "pending");
      saveToolCall(ctx.db, {
        id: toolCallId,
        messageId: ctx.messageId,
        name: title || kind || "tool",
        args,
        status: dbStatus,
        category: mapAcpKindToCategory(kind),
      });
      ctx.webContents.send(CH.SESSION_TOOL_CALL, {
        session_id: ctx.aiSessionId,
        tool_name: title || kind || "tool",
        tool_call_id: toolCallId,
        input: args,
      });
      break;
    }

    case "tool_call_update": {
      const { toolCallId, status, content, rawOutput } = update;
      if (!toolCallId) break;
      if (status) {
        const mapped = mapAcpStatus(status);
        const output = rawOutput !== undefined
          ? rawOutput
          : extractToolCallContent(content);
        if (mapped === "complete" || mapped === "error") {
          updateToolCallStatus(ctx.db, toolCallId, mapped, output);
          ctx.webContents.send(CH.SESSION_TOOL_RESULT, {
            session_id: ctx.aiSessionId,
            tool_name: toolCallId,
            output,
          });
        } else {
          updateToolCallStatus(ctx.db, toolCallId, mapped);
        }
      }
      break;
    }

    case "plan":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
      // Not surfaced in v1.
      break;

    default:
      console.warn(`[acp] unhandled session/update kind: ${update.sessionUpdate}`);
  }
}

function extractText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const c = content as { type?: string; text?: string };
  if (c.type === "text" && typeof c.text === "string") return c.text;
  return "";
}

function extractToolCallContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  // Concatenate text from any "content"-type entries; pass other entries through.
  const text = content
    .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "content")
    .map((c) => extractText((c as { content?: unknown }).content))
    .filter((t) => t.length > 0)
    .join("");
  return text || content;
}

/** ACP `ToolCallStatus` → AIchemist `ToolCallStatus`. */
export function mapAcpStatus(status: string): "pending_approval" | "approved" | "complete" | "error" {
  switch (status) {
    case "pending":
      return "pending_approval";
    case "in_progress":
      return "approved";
    case "completed":
      return "complete";
    case "failed":
      return "error";
    default:
      return "approved";
  }
}

/** ACP `ToolKind` → AIchemist tool category. */
export function mapAcpKindToCategory(kind: string | undefined): string {
  switch (kind) {
    case "edit":
    case "read":
    case "delete":
    case "move":
    case "search":
    case "fetch":
      return "filesystem";
    case "execute":
      return "shell";
    case "think":
    case "other":
    default:
      return "other";
  }
}

// ── fs/write_text_file: route through approval gate ──────────────────────────

async function handleAcpWriteFile(
  ctx: RuntimeContext,
  params: { sessionId: string; path: string; content: string }
): Promise<void> {
  if (!path.isAbsolute(params.path)) {
    throw new Error(`fs/write_text_file requires an absolute path; got "${params.path}"`);
  }

  const synthArgs: Record<string, unknown> = { path: params.path };
  const category: ToolCategory = "filesystem";
  const toolName = "fs_write";
  const toolCallId = crypto.randomUUID();

  saveToolCall(ctx.db, {
    id: toolCallId,
    messageId: ctx.messageId,
    name: toolName,
    args: synthArgs,
    status: "pending_approval",
    category,
  });
  ctx.webContents.send(CH.SESSION_TOOL_CALL, {
    session_id: ctx.aiSessionId,
    tool_name: toolName,
    tool_call_id: toolCallId,
    input: synthArgs,
  });

  const needs = requiresApproval(ctx.aiSessionId, ctx.projectConfig, category, toolName, synthArgs);
  if (needs) {
    const approved = await requestApproval(ctx.webContents, ctx.aiSessionId, toolName, synthArgs);
    if (!approved) {
      updateToolCallStatus(ctx.db, toolCallId, "rejected");
      ctx.webContents.send(CH.SESSION_TOOL_RESULT, {
        session_id: ctx.aiSessionId,
        tool_name: toolName,
        output: "denied by user",
      });
      throw new Error("fs/write_text_file denied by user");
    }
  }
  updateToolCallStatus(ctx.db, toolCallId, "approved");

  const { result, change } = await implWriteFileWithChange(
    { path: params.path, content: params.content },
    ctx.projectPath
  );

  if (result.startsWith("Error")) {
    updateToolCallStatus(ctx.db, toolCallId, "error", result);
    ctx.webContents.send(CH.SESSION_TOOL_RESULT, {
      session_id: ctx.aiSessionId,
      tool_name: toolName,
      output: result,
    });
    throw new Error(result);
  }

  updateToolCallStatus(ctx.db, toolCallId, "complete", result);
  ctx.webContents.send(CH.SESSION_TOOL_RESULT, {
    session_id: ctx.aiSessionId,
    tool_name: toolName,
    output: result,
  });
  if (change) {
    ctx.webContents.send(CH.SESSION_FILE_CHANGE, {
      session_id: ctx.aiSessionId,
      file_change: change,
    });
  }
}

async function handleAcpReadFile(
  ctx: RuntimeContext,
  params: { sessionId: string; path: string; line?: number | null; limit?: number | null }
): Promise<{ content: string }> {
  if (!path.isAbsolute(params.path)) {
    throw new Error(`fs/read_text_file requires an absolute path; got "${params.path}"`);
  }
  // Constrain to project root. Use async fs to avoid blocking the Electron
  // main thread on multi-MB reads.
  const resolved = path.resolve(params.path);
  const realResolved = await fs.promises.realpath(resolved);
  const projectReal = await getProjectRealpath(ctx.projectPath);
  if (!realResolved.startsWith(projectReal + path.sep) && realResolved !== projectReal) {
    throw new Error(`fs/read_text_file path "${params.path}" is outside the project root`);
  }
  const content = await fs.promises.readFile(realResolved, "utf8");
  // Apply line/limit if provided.
  if (params.line != null || params.limit != null) {
    const lines = content.split("\n");
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end = params.limit != null ? start + params.limit : undefined;
    return { content: lines.slice(start, end).join("\n") };
  }
  return { content };
}

/** Per-projectPath cache of `fs.realpath(projectPath)` to avoid re-resolving on every read. */
const projectRealpathCache = new Map<string, string>();
async function getProjectRealpath(projectPath: string): Promise<string> {
  const cached = projectRealpathCache.get(projectPath);
  if (cached) return cached;
  const real = await fs.promises.realpath(projectPath);
  projectRealpathCache.set(projectPath, real);
  return real;
}

// ── Provider entrypoint ──────────────────────────────────────────────────────

async function run(params: AgentProviderParams): Promise<string> {
  const sdk = await loadSdk();
  const cfg = params.projectConfig.acp_agent;
  if (!cfg || !cfg.command) {
    throw new Error('ACP provider requires `acp_agent.command` to be set in project config.');
  }

  const handle = await getOrCreateConnection(params.projectPath, cfg);
  const connection = handle.connection as {
    newSession(req: { cwd: string; mcpServers: unknown[] }): Promise<{ sessionId: string }>;
    prompt(req: { sessionId: string; prompt: Array<{ type: string; text: string }> }): Promise<{ stopReason: string }>;
  };

  // Always create a new ACP session per AIchemist session (v1 — no session/load).
  let acpSessionId = acpSessionIds.get(params.sessionId);
  if (!acpSessionId) {
    try {
      const newRes = await connection.newSession({
        cwd: params.projectPath,
        mcpServers: [],
      });
      acpSessionId = newRes.sessionId;
      acpSessionIds.set(params.sessionId, acpSessionId);
      // Track which subprocess issued this id so we can evict on exit/error.
      let connSet = acpSessionsByConnection.get(handle.key);
      if (!connSet) {
        connSet = new Set();
        acpSessionsByConnection.set(handle.key, connSet);
      }
      connSet.add(acpSessionId);
      setAcpSessionId(params.db, params.sessionId, acpSessionId);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (handle.authMethods.length > 0 && /auth/i.test(msg)) {
        const methods = handle.authMethods.map((m) => `- ${m.id}${m.name ? ` (${m.name})` : ""}`).join("\n");
        throw new Error(
          `ACP agent requires authentication. Set \`acp_agent.auth_method_id\` in project settings.\nAvailable methods:\n${methods}`
        );
      }
      throw err;
    }
  }

  // Register the runtime context for callbacks.
  const ctx: RuntimeContext = {
    db: params.db,
    webContents: params.webContents,
    aiSessionId: params.sessionId,
    messageId: params.messageId,
    projectConfig: params.projectConfig,
    projectPath: params.projectPath,
    buffer: [],
    toolCallIds: new Set(),
  };
  activeRuntimes.set(acpSessionId, ctx);

  try {
    const promptResult = await connection.prompt({
      sessionId: acpSessionId,
      prompt: [{ type: "text", text: params.prompt }],
    });

    if (promptResult.stopReason === "refusal") {
      // Surface as part of the buffered text rather than throwing.
      ctx.buffer.push("\n[Agent refused to respond]");
    }
    if (promptResult.stopReason === "max_tokens" || promptResult.stopReason === "max_turn_requests") {
      ctx.buffer.push(`\n[Stopped: ${promptResult.stopReason}]`);
    }

    return ctx.buffer.join("");
  } finally {
    activeRuntimes.delete(acpSessionId);
  }
  // Suppress unused-import warnings for the SDK reference (used at runtime via `sdk` var above for ndJsonStream/PROTOCOL_VERSION inside spawn helper).
  void sdk;
}

async function stop(): Promise<void> {
  for (const handle of connections.values()) {
    try {
      handle.proc.kill();
    } catch (err) {
      console.warn(`[acp] failed to kill ${handle.key}:`, err);
    }
  }
  connections.clear();
  pendingConnections.clear();
  acpSessionIds.clear();
  acpSessionsByConnection.clear();
  activeRuntimes.clear();
}

export const acpProvider: AgentProvider = { run, stop };

// ── Test hooks ───────────────────────────────────────────────────────────────

export function _resetAcpStateForTests(): void {
  for (const handle of connections.values()) {
    try {
      handle.proc.kill();
    } catch { /* ignore */ }
  }
  connections.clear();
  pendingConnections.clear();
  acpSessionIds.clear();
  acpSessionsByConnection.clear();
  activeRuntimes.clear();
  projectRealpathCache.clear();
  sdkPromise = null;
}
