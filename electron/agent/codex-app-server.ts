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
import { JsonRpcPeer, createStdioTransport } from "./jsonrpc";

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

export class CodexAppServerClient {
  private readonly peer: JsonRpcPeer;
  private readonly closeConn: () => void;
  private activeTurn: AsyncEventQueue<AppServerTurnEvent> | null = null;
  /** The running turn's id (from the turn/start response) — needed to interrupt. */
  private activeTurnId: string | null = null;
  /** Latest token usage (arrives separately via `thread/tokenUsage/updated`). */
  private lastUsage: unknown = null;

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
   * Start a turn and stream its events until `turn/completed` (or `turn/failed`).
   * Only one turn runs at a time per client.
   */
  async *runTurn(threadId: string, text: string): AsyncGenerator<AppServerTurnEvent> {
    if (this.activeTurn) throw new Error("Codex app-server: a turn is already in progress");
    const queue = new AsyncEventQueue<AppServerTurnEvent>();
    this.activeTurn = queue;
    this.activeTurnId = null;
    this.lastUsage = null;
    // Fire the turn and drive completion from the streamed notifications — the
    // turn/start *response* just carries the initial turn (we capture its id so
    // we can interrupt), while turn/completed / turn/failed notifications end the
    // stream. We do NOT await the response (it may be deferred); a rejection
    // fails the turn.
    this.peer.request("turn/start", { threadId, input: [{ type: "text", text }] }).then(
      (res) => {
        this.activeTurnId = (res as { turn?: { id?: string } } | null)?.turn?.id ?? null;
      },
      (err) => {
        queue.push({ type: "turn.failed", error: { message: err instanceof Error ? err.message : String(err) } });
        queue.end();
      },
    );
    try {
      yield* queue.drain();
    } finally {
      // If the consumer abandoned the turn before it ended (broke out of the
      // loop), interrupt the still-running server-side turn so it can't keep
      // executing or interleave with the next turn. Best-effort.
      if (!queue.isEnded && this.activeTurnId) {
        void this.peer
          .request("turn/interrupt", { threadId, turnId: this.activeTurnId })
          .catch(() => {});
      }
      this.activeTurn = null;
      this.activeTurnId = null;
    }
  }

  /**
   * The peer/connection closed (process died, transport error). Fail the active
   * turn so its stream ends instead of hanging on notifications that will never
   * arrive.
   */
  private handlePeerClose(err?: Error): void {
    const queue = this.activeTurn;
    if (queue && !queue.isEnded) {
      queue.push({ type: "turn.failed", error: { message: err?.message ?? "app-server connection closed" } });
      queue.end();
    }
  }

  /** Tear down the turn stream and the underlying connection. */
  close(): void {
    this.activeTurn?.end();
    this.activeTurn = null;
    this.activeTurnId = null;
    this.closeConn();
  }

  private handleNotification(method: string, params: unknown): void {
    const queue = this.activeTurn;
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "turn/started":
        queue?.push({ type: "turn.started" });
        break;
      case "item/started":
        queue?.push({ type: "item.started", item: p.item });
        break;
      case "item/updated":
        queue?.push({ type: "item.updated", item: p.item });
        break;
      case "item/completed":
        queue?.push({ type: "item.completed", item: p.item });
        break;
      case "thread/tokenUsage/updated":
        // Usage streams separately from turn/completed; remember the latest.
        this.lastUsage = params;
        break;
      case "turn/completed": {
        const error = extractTurnError(p);
        if (error) queue?.push({ type: "turn.failed", error });
        else queue?.push({ type: "turn.completed", usage: this.lastUsage });
        queue?.end();
        break;
      }
      case "turn/failed": {
        queue?.push({ type: "turn.failed", error: extractTurnError(p) ?? { message: "turn failed" } });
        queue?.end();
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

    const transport = createStdioTransport(child.stdout!, child.stdin!);
    const peer = new JsonRpcPeer(transport, {
      onNotification: handlers.onNotification,
      onRequest: handlers.onRequest,
      onClose: handlers.onClose,
    });
    // The process dying is a connection close too — surface it to the peer so an
    // active turn fails rather than hanging.
    child.on("exit", (code) => handlers.onClose(new Error(`codex app-server exited (code ${code})`)));

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
