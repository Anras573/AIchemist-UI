/**
 * Minimal JSON-RPC peer over a child process's stdio, for driving the Codex
 * `app-server` / `mcp-server` transports (see
 * docs/plans/2026-06-29-codex-approval-bridging-spike.md).
 *
 * Two layers, so the correlation/dispatch core is testable without real streams:
 *
 * - {@link JsonRpcPeer} — transport-agnostic. Correlates outbound requests with
 *   their responses, sends/receives notifications, and — crucially for approval
 *   bridging — handles inbound **server→client requests** by invoking a handler
 *   and replying with its result/error.
 * - {@link createStdioTransport} — a newline-delimited-JSON (NDJSON) adapter over
 *   a child process's `stdout`/`stdin`.
 *
 * Framing note: Codex's app-server speaks a JSON-RPC *style* protocol but omits
 * the `jsonrpc: "2.0"` version tag (its docs show `{ "method", "id", "params" }`
 * / `{ "id", "result" }`). We therefore classify messages **structurally** and
 * never require the version field. The field is preserved if a peer sends it.
 */
import type { Readable, Writable } from "node:stream";

export type JsonRpcId = number | string;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A decoded inbound/outbound message. Classified structurally (see below). */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

/** Moves already-decoded messages to/from the peer (real impl: NDJSON over stdio). */
export interface JsonRpcTransport {
  send(message: JsonRpcMessage): void;
  /** Register the single sink for decoded inbound messages. */
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  /** Register the single close/EOF/error sink. */
  onClose(handler: (err?: Error) => void): void;
  close(): void;
}

/** Error thrown when the peer closes (or is closed) with requests still in flight. */
export class JsonRpcClosedError extends Error {
  constructor(message = "JSON-RPC peer closed") {
    super(message);
    this.name = "JsonRpcClosedError";
  }
}

/** Error carrying a JSON-RPC error object returned by the remote for a request. */
export class JsonRpcRemoteError extends Error {
  constructor(public readonly rpcError: JsonRpcError) {
    super(rpcError.message);
    this.name = "JsonRpcRemoteError";
  }
}

export interface JsonRpcPeerOptions {
  /** Dispatch for inbound notifications (no `id`). Fail-safe — a throw is logged. */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * Dispatch for inbound server→client requests (have both `id` and `method`).
   * The resolved value becomes the response `result`; a throw becomes an `error`.
   * No timeout is applied here — an approval handler may legitimately block on
   * the user (the caller owns that timeout).
   */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Default per-request timeout (ms) for outbound {@link JsonRpcPeer.request}. 0 disables. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class JsonRpcPeer {
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly options: JsonRpcPeerOptions = {},
  ) {
    transport.onMessage((m) => this.handleMessage(m));
    transport.onClose((err) => this.handleClose(err));
  }

  /** Send an outbound request and resolve with its `result` (or reject with the error/timeout/close). */
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
    if (this.closed) return Promise.reject(new JsonRpcClosedError());
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? this.options.requestTimeoutMs ?? 0;

    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`JSON-RPC request "${method}" timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      // A throwing transport closes the peer; handleClose then rejects this
      // pending entry (and clears its timer) too, so no cleanup is needed here.
      this.safeSend({ id, method, params });
    });
  }

  /** Send an outbound notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.safeSend({ method, params });
  }

  /**
   * Send through the transport, tolerating a throwing transport (the peer is
   * transport-agnostic). A synchronous send failure means the connection is
   * dead, so close the peer — rejecting all in-flight requests — rather than
   * letting the throw escape to callers (`notify`, inbound responses) and crash.
   */
  private safeSend(message: JsonRpcMessage): void {
    try {
      this.transport.send(message);
    } catch (err) {
      this.handleClose(err instanceof Error ? err : new Error(String(err)));
      // Also tear down the transport itself (detach listeners, end stdin) so a
      // broken connection doesn't leak listeners / keep the reader buffer alive.
      try {
        this.transport.close();
      } catch {
        // A broken transport's close() may throw — it's being discarded anyway.
      }
    }
  }

  /** Close the peer: reject all in-flight requests and close the transport. */
  close(): void {
    this.handleClose();
    this.transport.close();
  }

  private handleMessage(message: JsonRpcMessage): void {
    // Structural classification (no `jsonrpc` version tag required):
    // - method + id  → inbound request (server→client)
    // - method only  → notification
    // - id only      → response to one of our requests
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        void this.handleInboundRequest(message.id, message.method, message.params);
      } else {
        this.handleNotification(message.method, message.params);
      }
      return;
    }
    if (message.id !== undefined) {
      this.handleResponse(message);
    }
    // Anything else (no method, no id) is malformed — ignore.
  }

  private handleNotification(method: string, params: unknown): void {
    try {
      this.options.onNotification?.(method, params);
    } catch (err) {
      console.error(`[jsonrpc] notification handler threw for "${method}":`, err);
    }
  }

  private async handleInboundRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.options.onRequest;
    if (!handler) {
      this.safeSend({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    try {
      const result = await handler(method, params);
      // `JSON.stringify` drops an `undefined` result, producing a malformed
      // `{ id }` response (which a peer would reject) — normalize to null.
      if (!this.closed) this.safeSend({ id, result: result ?? null });
    } catch (err) {
      if (!this.closed) {
        this.safeSend({
          id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  private handleResponse(message: JsonRpcMessage): void {
    const pending = this.pending.get(message.id!);
    if (!pending) return; // unknown / already-settled id
    this.pending.delete(message.id!);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new JsonRpcRemoteError(message.error));
    } else if ("result" in message) {
      // A `result` of `null`/`undefined` is legitimate; key presence is what
      // distinguishes a real (if empty) response from a malformed one.
      pending.resolve(message.result);
    } else {
      // Neither `result` nor `error` — malformed. Reject rather than silently
      // resolving `undefined` (and rather than leaving the request to hang).
      pending.reject(new Error(`Malformed JSON-RPC response for id ${String(message.id)}: missing result and error`));
    }
  }

  private handleClose(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const failure = err ?? new JsonRpcClosedError();
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
  }
}

/**
 * Default cap on a single unterminated line, measured in characters (UTF-16 code
 * units — the direct measure of the buffer's in-memory size). A child that emits
 * a huge line (or never a newline) would otherwise grow the buffer without
 * bound; exceeding the cap closes the transport rather than risking unbounded
 * memory.
 */
export const DEFAULT_MAX_LINE_LENGTH = 16 * 1024 * 1024; // 16M chars

/**
 * NDJSON transport over a child process's streams: one JSON object per line.
 * Tolerates chunk boundaries that split or merge messages, and skips blank /
 * unparseable / non-object lines (logged) rather than tearing down the peer. A
 * single line exceeding `maxLineLength` closes the transport (memory safety).
 */
export function createStdioTransport(
  stdout: Readable,
  stdin: Writable,
  options?: { maxLineLength?: number },
): JsonRpcTransport {
  const maxLineLength = options?.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  let messageHandler: ((message: JsonRpcMessage) => void) | null = null;
  let closeHandler: ((err?: Error) => void) | null = null;
  let buffer = "";
  let closeEmitted = false;

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.error(`[jsonrpc] dropping unparseable line: ${line.slice(0, 200)}`);
        continue;
      }
      // Parseable but non-object JSON (`null`, `[]`, `42`, `"x"`) is not a valid
      // message — forwarding it would crash the peer (e.g. `null.method`).
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error(`[jsonrpc] dropping non-object message: ${line.slice(0, 200)}`);
        continue;
      }
      messageHandler?.(parsed as JsonRpcMessage);
    }
    // The remaining buffer is an as-yet-unterminated line; bound its growth.
    if (buffer.length > maxLineLength) {
      buffer = "";
      emitClose(new Error(`JSON-RPC line exceeded ${maxLineLength} characters without a newline`));
    }
  };

  // `error`, `close`, and `end` can all fire (and in combination) for one EOF;
  // emit `onClose` at most once and detach every listener so repeated transport
  // creation can't leak them.
  const detach = (): void => {
    stdout.off("data", onData);
    stdout.off("error", onError);
    stdout.off("close", onEnd);
    stdout.off("end", onEnd);
    stdin.off("error", onStdinError);
  };
  const emitClose = (err?: Error): void => {
    if (closeEmitted) return;
    closeEmitted = true;
    detach();
    closeHandler?.(err);
  };
  const onError = (err: Error): void => emitClose(err);
  const onEnd = (): void => emitClose();
  // A broken pipe usually surfaces as a stdin `error` event; route it (and any
  // synchronous write failure in send() below) through emitClose so the peer
  // transitions to closed and rejects in-flight requests, rather than crashing.
  const onStdinError = (err: Error): void => emitClose(err);

  stdout.on("data", onData);
  stdout.on("error", onError);
  stdout.on("close", onEnd);
  stdout.on("end", onEnd);
  stdin.on("error", onStdinError);

  return {
    send(message: JsonRpcMessage): void {
      try {
        stdin.write(JSON.stringify(message) + "\n");
      } catch (err) {
        // A synchronous write failure (broken pipe / write-after-end) must not
        // propagate to callers (notify / inbound-response sends) — surface it as
        // a transport close instead, consistent with the async error path.
        emitClose(err instanceof Error ? err : new Error(String(err)));
      }
    },
    onMessage(handler): void {
      messageHandler = handler;
    },
    onClose(handler): void {
      closeHandler = handler;
    },
    close(): void {
      // Caller-initiated shutdown: detach (idempotent via the flag) without
      // emitting onClose — the caller already knows it's closing.
      closeEmitted = true;
      detach();
      try {
        stdin.end();
      } catch {
        // already closed — nothing to do
      }
    },
  };
}
