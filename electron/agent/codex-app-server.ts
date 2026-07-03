/**
 * Codex `app-server` client (slice 2/4 of #128 — interactive approval bridging;
 * see docs/plans/2026-06-29-codex-approval-bridging-spike.md).
 *
 * Unlike `@openai/codex-sdk` (which drives one-shot `codex exec`), the app-server
 * is a long-running JSON-RPC peer that can issue **server→client approval
 * requests** mid-turn. This module drives it over the {@link JsonRpcPeer} from
 * slice 1:
 *
 *   initialize -> thread/start -> turn/start -> stream turn and item notifications
 *   (and answer the item ".../requestApproval" requests).
 *
 * Scope of this slice: transport + turn lifecycle + approval-request *routing*.
 * It is deliberately **not wired into the provider** (slice 3) and does not map
 * approval requests to the real UI (slice 4 — the default handler denies).
 *
 * Shape boundary: the app-server's `item` / token-usage payloads use different
 * field naming than the exec SDK's `ThreadItem`, so this slice passes those
 * payloads through as `unknown`. Normalizing them into the shared emitter/
 * recorder mapping is slice 3's job.
 */
import { spawn } from "node:child_process";
import { JsonRpcPeer, createStdioTransport, type JsonRpcTransport } from "./jsonrpc";

// ── Public types ──────────────────────────────────────────────────────────────

/** App-server sandbox modes (camelCase wire values, per the `thread/start` protocol). */
export type AppServerSandbox = "readOnly" | "workspaceWrite" | "dangerFullAccess";

/** App-server approval policies. Callers map their own policy onto these. */
export type AppServerApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

/**
 * Options for `thread/start`, using the app-server's own wire naming — the
 * caller (slice 3) maps AIchemist's kebab-case sandbox (`workspace-write`, …)
 * onto {@link AppServerSandbox} (`workspaceWrite`, …).
 */
export interface AppServerThreadOptions {
  model?: string;
  cwd?: string;
  approvalPolicy?: AppServerApprovalPolicy;
  sandbox?: AppServerSandbox;
  /** Extra `--config`-style overrides, e.g. `{ mcp_servers: {...} }`. */
  config?: Record<string, unknown>;
}

/**
 * A turn event, mirroring the SDK's `ThreadEvent` *structure* but leaving `item`
 * and `usage` as raw app-server payloads (normalized in slice 3).
 */
export type AppServerTurnEvent =
  | { type: "turn.started" }
  | { type: "item.started"; item: unknown }
  | { type: "item.updated"; item: unknown }
  | { type: "item.completed"; item: unknown }
  | { type: "turn.completed"; usage: unknown }
  | { type: "turn.failed"; error: { message: string } };

/** An inbound approval request (server→client), routed to the approval handler. */
export interface AppServerApprovalRequest {
  method: string;
  params: unknown;
}

/** Resolves an approval request into the JSON-RPC `result` sent back to the server. */
export type AppServerApprovalHandler = (req: AppServerApprovalRequest) => Promise<unknown>;

/** A live connection: the peer plus a teardown for its underlying process/streams. */
export interface AppServerConnection {
  peer: JsonRpcPeer;
  close: () => void;
}

/**
 * Builds a connection, wiring the client's notification/approval handlers into
 * the peer. Injected so tests can supply a mock peer; the default spawns the
 * `codex app-server` binary ({@link spawnAppServerConnector}).
 */
export type AppServerConnector = (handlers: {
  onNotification: (method: string, params: unknown) => void;
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  /** Fired when the underlying peer/connection closes (e.g. the process died). */
  onClose: (err?: Error) => void;
}) => AppServerConnection;

/** Default approval handler: deny everything (real UI mapping lands in slice 4). */
export const denyAllApprovals: AppServerApprovalHandler = async () => ({ decision: "deny" });

// ── Async event queue (notification stream → async generator) ──────────────────

/** Single-consumer queue bridging pushed notifications into `for await`. */
class AsyncEventQueue<T> {
  private readonly buffer: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private ended = false;

  get isEnded(): boolean {
    return this.ended;
  }

  push(value: T): void {
    if (this.ended) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

// ── Client ─────────────────────────────────────────────────────────────────────

/**
 * State for one in-flight turn. Scoping it to a per-turn object (rather than
 * instance fields) means a late/stale callback from a superseded turn writes to
 * its own dead context and can never clobber the current turn's id/usage.
 */
interface TurnContext {
  readonly queue: AsyncEventQueue<AppServerTurnEvent>;
  readonly threadId: string;
  /** The running turn's id (from the turn/start response) — needed to interrupt. */
  turnId: string | null;
  /** Latest token usage for THIS turn (thread/tokenUsage/updated streams separately). */
  usage: unknown;
  /**
   * Set when the consumer abandoned the turn before its id was known. The
   * turn/start response callback interrupts as soon as the id arrives, so a
   * turn abandoned mid-flight can't keep running server-side.
   */
  abandoned: boolean;
}

export class CodexAppServerClient {
  private readonly peer: JsonRpcPeer;
  private readonly closeConn: () => void;
  private activeTurn: TurnContext | null = null;

  constructor(
    connect: AppServerConnector,
    private readonly onApprovalRequest: AppServerApprovalHandler = denyAllApprovals,
  ) {
    const conn = connect({
      onNotification: (method, params) => this.handleNotification(method, params),
      // Inbound server→client requests are approval requests; route them.
      onRequest: (method, params) => this.onApprovalRequest({ method, params }),
      onClose: (err) => this.handlePeerClose(err),
    });
    this.peer = conn.peer;
    this.closeConn = conn.close;
  }

  /** Run the initialize handshake. Must be called before starting threads. */
  async initialize(): Promise<void> {
    await this.peer.request("initialize", {
      clientInfo: { name: "aichemist", version: "0" },
    });
  }

  /** Start a new thread; returns its id. */
  async startThread(options: AppServerThreadOptions = {}): Promise<string> {
    const result = (await this.peer.request("thread/start", options)) as {
      thread?: { id?: string };
    };
    const id = result?.thread?.id;
    if (!id) throw new Error("Codex app-server: thread/start returned no thread id");
    return id;
  }

  /**
   * Reopen an existing thread by id (a fresh app-server process can resume a
   * thread the exec path or a prior process persisted) so subsequent
   * `turn/start` calls append to it. Options apply the same overrides as
   * `startThread`. Returns the thread id.
   */
  async resumeThread(threadId: string, options: AppServerThreadOptions = {}): Promise<string> {
    const result = (await this.peer.request("thread/resume", { threadId, ...options })) as {
      thread?: { id?: string };
    };
    const id = result?.thread?.id;
    if (!id) throw new Error("Codex app-server: thread/resume returned no thread id");
    return id;
  }

  /**
   * Start a turn and stream its events until `turn/completed` (or `turn/failed`).
   * Only one turn runs at a time per client.
   */
  async *runTurn(threadId: string, text: string): AsyncGenerator<AppServerTurnEvent> {
    if (this.activeTurn) throw new Error("Codex app-server: a turn is already in progress");
    const ctx: TurnContext = {
      queue: new AsyncEventQueue<AppServerTurnEvent>(),
      threadId,
      turnId: null,
      usage: null,
      abandoned: false,
    };
    this.activeTurn = ctx;
    // Fire the turn and drive completion from the streamed notifications — the
    // turn/start *response* just carries the initial turn (we capture its id so
    // we can interrupt), while turn/completed / turn/failed notifications end the
    // stream. We do NOT await the response (it may be deferred); a rejection
    // fails the turn. All writes target `ctx`, so a late response from a
    // superseded turn updates its own dead context, never the current one.
    this.peer.request("turn/start", { threadId, input: [{ type: "text", text }] }).then(
      (res) => {
        ctx.turnId = (res as { turn?: { id?: string } } | null)?.turn?.id ?? null;
        // If the consumer already abandoned the turn while we were waiting for
        // the id, interrupt now that we finally know it. Best-effort.
        if (ctx.abandoned && ctx.turnId) {
          void this.peer.request("turn/interrupt", { threadId, turnId: ctx.turnId }).catch(() => {});
        }
      },
      (err) => {
        ctx.queue.push({ type: "turn.failed", error: { message: err instanceof Error ? err.message : String(err) } });
        ctx.queue.end();
      },
    );
    try {
      yield* ctx.queue.drain();
    } finally {
      // If the consumer abandoned the turn before it ended (broke out of the
      // loop), interrupt the still-running server-side turn so it can't keep
      // executing or interleave with the next turn. Best-effort. If the turn id
      // isn't known yet (turn/start response still pending), mark it abandoned
      // so the response callback interrupts as soon as the id arrives.
      if (!ctx.queue.isEnded) {
        if (ctx.turnId) {
          void this.peer.request("turn/interrupt", { threadId, turnId: ctx.turnId }).catch(() => {});
        } else {
          ctx.abandoned = true;
        }
      }
      if (this.activeTurn === ctx) this.activeTurn = null;
    }
  }

  /**
   * The peer/connection closed (process died, transport error). Fail the active
   * turn so its stream ends instead of hanging on notifications that will never
   * arrive.
   */
  private handlePeerClose(err?: Error): void {
    const ctx = this.activeTurn;
    if (ctx && !ctx.queue.isEnded) {
      ctx.queue.push({ type: "turn.failed", error: { message: err?.message ?? "app-server connection closed" } });
      ctx.queue.end();
    }
  }

  /** Tear down the turn stream and the underlying connection. */
  close(): void {
    this.activeTurn?.queue.end();
    this.activeTurn = null;
    this.closeConn();
  }

  private handleNotification(method: string, params: unknown): void {
    const ctx = this.activeTurn;
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "turn/started":
        ctx?.queue.push({ type: "turn.started" });
        break;
      case "item/started":
        ctx?.queue.push({ type: "item.started", item: p.item });
        break;
      case "item/updated":
        ctx?.queue.push({ type: "item.updated", item: p.item });
        break;
      case "item/completed":
        ctx?.queue.push({ type: "item.completed", item: p.item });
        break;
      case "thread/tokenUsage/updated":
        // Usage streams separately; attach it to the ACTIVE turn only, so a late
        // update between turns can't leak into the next turn's turn.completed.
        if (ctx) ctx.usage = params;
        break;
      case "turn/completed": {
        const error = extractTurnError(p);
        if (error) ctx?.queue.push({ type: "turn.failed", error });
        else {
          // turn/completed may carry usage inline; prefer it, falling back to the
          // last streamed thread/tokenUsage/updated snapshot when it doesn't.
          const inline = extractTurnUsage(p);
          ctx?.queue.push({ type: "turn.completed", usage: inline ?? ctx?.usage ?? null });
        }
        ctx?.queue.end();
        break;
      }
      case "turn/failed": {
        ctx?.queue.push({ type: "turn.failed", error: extractTurnError(p) ?? { message: "turn failed" } });
        ctx?.queue.end();
        break;
      }
      // thread/started, item/agentMessage/delta, etc. are ignored in this slice.
    }
  }
}

/** Pull a `{ message }` error out of a turn/completed|failed payload, if present. */
function extractTurnError(params: Record<string, unknown>): { message: string } | null {
  const turn = params.turn as { error?: unknown } | undefined;
  const raw = (turn?.error ?? params.error) as { message?: unknown } | string | null | undefined;
  if (!raw) return null;
  if (typeof raw === "string") return { message: raw };
  return { message: typeof raw.message === "string" ? raw.message : "turn failed" };
}

/** Pull an inline usage payload out of a turn/completed body, if present. */
function extractTurnUsage(params: Record<string, unknown>): unknown {
  const turn = params.turn as { usage?: unknown } | undefined;
  return turn?.usage ?? params.usage ?? null;
}

// ── Default connector: spawn the `codex app-server` binary ────────────────────

/**
 * Spawn `codex app-server` and wire it to a {@link JsonRpcPeer} over stdio.
 *
 * NOTE: not exercised by unit tests (no binary interaction) — it's the real
 * transport slice 3 will use. The binary is the same one the SDK resolves
 * (`CODEX_CLI_PATH` or the bundled `@openai/codex-<platform>`); auth via
 * `CODEX_API_KEY`.
 */
export function spawnAppServerConnector(config: {
  binaryPath: string;
  apiKey: string;
  baseUrl?: string;
  cwd?: string;
}): AppServerConnector {
  return (handlers) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_API_KEY: config.apiKey };
    if (config.baseUrl) env.OPENAI_BASE_URL = config.baseUrl;

    const child = spawn(config.binaryPath, ["app-server"], {
      cwd: config.cwd,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });

    // Both the transport EOF (via the peer's onClose) and the child's `exit`
    // signal a close; funnel them through a single one-shot so onClose fires
    // exactly once, preferring the exit reason when we have it.
    let closed = false;
    let exitReason: Error | undefined;
    const fireClose = (err?: Error): void => {
      if (closed) return;
      closed = true;
      handlers.onClose(exitReason ?? err);
    };

    // On a spawn failure (ENOENT / EACCES) the stdio streams can be null; that
    // would crash createStdioTransport before the `error` handler below runs.
    // Fall back to a dead transport so close is driven entirely by error/exit.
    const transport: JsonRpcTransport =
      child.stdout && child.stdin
        ? createStdioTransport(child.stdout, child.stdin)
        : { send: () => {}, onMessage: () => {}, onClose: () => {}, close: () => {} };
    const peer = new JsonRpcPeer(transport, {
      onNotification: handlers.onNotification,
      onRequest: handlers.onRequest,
      onClose: fireClose,
    });
    // A spawn failure (e.g. ENOENT for a missing binary) emits `error`; without a
    // listener Node throws it as an uncaught exception and crashes the process.
    // Capture it as the close reason and tear the peer down.
    child.on("error", (err) => {
      exitReason = new Error(`codex app-server failed to start: ${err.message}`);
      peer.close();
    });
    // On exit, route through peer.close() so pending requests are rejected first,
    // then onClose fires once with the exit reason (peer.close → handleClose →
    // fireClose, which is already guarded). Include the signal when the process
    // was killed (code is null in that case) so the reason isn't "code null".
    child.on("exit", (code, signal) => {
      exitReason = new Error(
        `codex app-server exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})`,
      );
      peer.close();
    });

    return {
      peer,
      close: () => {
        peer.close();
        try {
          child.kill();
        } catch {
          // already exited
        }
      },
    };
  };
}
