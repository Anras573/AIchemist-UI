// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  JsonRpcPeer,
  JsonRpcClosedError,
  JsonRpcRemoteError,
  createStdioTransport,
  type JsonRpcMessage,
  type JsonRpcTransport,
} from "./jsonrpc";

// ── Fake in-memory transport (drives the peer core without real streams) ──────
function makeFakeTransport() {
  let messageHandler: ((m: JsonRpcMessage) => void) | null = null;
  let closeHandler: ((err?: Error) => void) | null = null;
  const sent: JsonRpcMessage[] = [];
  const transport: JsonRpcTransport = {
    send: (m) => sent.push(m),
    onMessage: (h) => { messageHandler = h; },
    onClose: (h) => { closeHandler = h; },
    close: vi.fn(),
  };
  return {
    transport,
    sent,
    receive: (m: JsonRpcMessage) => messageHandler!(m),
    triggerClose: (err?: Error) => closeHandler!(err),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("JsonRpcPeer", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves an outbound request when a matching response arrives", async () => {
    const t = makeFakeTransport();
    const peer = new JsonRpcPeer(t.transport);

    const p = peer.request("thread/start", { model: "gpt-5.1-codex" });
    expect(t.sent).toEqual([{ id: 1, method: "thread/start", params: { model: "gpt-5.1-codex" } }]);

    t.receive({ id: 1, result: { threadId: "thr_1" } });
    await expect(p).resolves.toEqual({ threadId: "thr_1" });
  });

  it("rejects an outbound request with JsonRpcRemoteError on an error response", async () => {
    const t = makeFakeTransport();
    const peer = new JsonRpcPeer(t.transport);

    const p = peer.request("turn/start");
    t.receive({ id: 1, error: { code: -32000, message: "boom" } });

    await expect(p).rejects.toBeInstanceOf(JsonRpcRemoteError);
    await expect(p).rejects.toMatchObject({ rpcError: { code: -32000, message: "boom" } });
  });

  it("times out an outbound request when configured", async () => {
    vi.useFakeTimers();
    const t = makeFakeTransport();
    const peer = new JsonRpcPeer(t.transport, { requestTimeoutMs: 1000 });

    const p = peer.request("slow");
    const expectation = expect(p).rejects.toThrow(/timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it("resolves a response whose result is explicitly null", async () => {
    const t = makeFakeTransport();
    const peer = new JsonRpcPeer(t.transport);
    const p = peer.request("m");
    t.receive({ id: 1, result: null });
    await expect(p).resolves.toBeNull();
  });

  it("rejects (not silently resolves) a malformed response with neither result nor error", async () => {
    const t = makeFakeTransport();
    const peer = new JsonRpcPeer(t.transport);
    const p = peer.request("m");
    t.receive({ id: 1 }); // no result, no error
    await expect(p).rejects.toThrow(/Malformed JSON-RPC response/);
  });

  it("ignores a response for an unknown / already-settled id", async () => {
    const t = makeFakeTransport();
    const peer = new JsonRpcPeer(t.transport);
    const p = peer.request("m");
    t.receive({ id: 999, result: "stray" }); // no matching pending
    t.receive({ id: 1, result: "ok" });
    await expect(p).resolves.toBe("ok");
  });

  it("sends a notification with no id", () => {
    const t = makeFakeTransport();
    const peer = new JsonRpcPeer(t.transport);
    peer.notify("client/ready", { v: 1 });
    expect(t.sent).toEqual([{ method: "client/ready", params: { v: 1 } }]);
  });

  it("dispatches an inbound notification to onNotification", () => {
    const onNotification = vi.fn();
    const t = makeFakeTransport();
    new JsonRpcPeer(t.transport, { onNotification });
    t.receive({ method: "turn/started", params: { turnId: "t1" } });
    expect(onNotification).toHaveBeenCalledWith("turn/started", { turnId: "t1" });
  });

  it("swallows a throwing notification handler", () => {
    const t = makeFakeTransport();
    new JsonRpcPeer(t.transport, {
      onNotification: () => {
        throw new Error("nope");
      },
    });
    expect(() => t.receive({ method: "x" })).not.toThrow();
  });

  it("answers an inbound request with the handler's result", async () => {
    const onRequest = vi.fn(async () => ({ scope: "turn", allow: true }));
    const t = makeFakeTransport();
    new JsonRpcPeer(t.transport, { onRequest });

    t.receive({ id: 7, method: "item/commandExecution/requestApproval", params: { command: "ls" } });
    await flush();

    expect(onRequest).toHaveBeenCalledWith("item/commandExecution/requestApproval", { command: "ls" });
    expect(t.sent).toEqual([{ id: 7, result: { scope: "turn", allow: true } }]);
  });

  it("normalizes an undefined inbound-request result to null", async () => {
    const t = makeFakeTransport();
    new JsonRpcPeer(t.transport, { onRequest: async () => undefined });
    t.receive({ id: 7, method: "ack", params: {} });
    await flush();
    expect(t.sent).toEqual([{ id: 7, result: null }]);
  });

  it("cleans up and rejects when the transport throws on send", async () => {
    const t = makeFakeTransport();
    t.transport.send = () => {
      throw new Error("transport down");
    };
    const peer = new JsonRpcPeer(t.transport);
    await expect(peer.request("m")).rejects.toThrow("transport down");
    // The pending entry was cleaned up: a late response for id 1 is a no-op.
    expect(() => t.receive({ id: 1, result: "late" })).not.toThrow();
  });

  it("does not throw out of notify() when the transport throws; closes the peer", async () => {
    const t = makeFakeTransport();
    const peer = new JsonRpcPeer(t.transport);
    const pending = peer.request("first"); // in flight before the bad send
    t.transport.send = () => {
      throw new Error("pipe gone");
    };
    expect(() => peer.notify("ping")).not.toThrow();
    // A throwing send closes the peer, rejecting in-flight requests.
    await expect(pending).rejects.toThrow("pipe gone");
  });

  it("does not throw when the transport throws while answering an inbound request", async () => {
    const t = makeFakeTransport();
    new JsonRpcPeer(t.transport, { onRequest: async () => ({ ok: true }) });
    t.transport.send = () => {
      throw new Error("pipe gone");
    };
    expect(() => t.receive({ id: 3, method: "approve", params: {} })).not.toThrow();
    await flush();
  });

  it("answers an inbound request with an error when the handler throws", async () => {
    const t = makeFakeTransport();
    new JsonRpcPeer(t.transport, {
      onRequest: async () => {
        throw new Error("denied internally");
      },
    });

    t.receive({ id: 8, method: "approve", params: {} });
    await flush();

    expect(t.sent).toEqual([{ id: 8, error: { code: -32603, message: "denied internally" } }]);
  });

  it("replies method-not-found to an inbound request when no onRequest handler is set", async () => {
    const t = makeFakeTransport();
    new JsonRpcPeer(t.transport);
    t.receive({ id: 9, method: "unhandled", params: {} });
    await flush();
    expect(t.sent).toEqual([{ id: 9, error: { code: -32601, message: "Method not found: unhandled" } }]);
  });

  it("rejects pending requests when closed by the caller", async () => {
    const t = makeFakeTransport();
    const peer = new JsonRpcPeer(t.transport);
    const p = peer.request("m");
    peer.close();
    await expect(p).rejects.toBeInstanceOf(JsonRpcClosedError);
    expect(t.transport.close).toHaveBeenCalled();
  });

  it("rejects pending requests when the transport closes (EOF/error)", async () => {
    const t = makeFakeTransport();
    const peer = new JsonRpcPeer(t.transport);
    const p = peer.request("m");
    t.triggerClose(new Error("stream died"));
    await expect(p).rejects.toThrow("stream died");
  });

  it("rejects a request issued after close", async () => {
    const t = makeFakeTransport();
    const peer = new JsonRpcPeer(t.transport);
    peer.close();
    await expect(peer.request("m")).rejects.toBeInstanceOf(JsonRpcClosedError);
  });
});

describe("createStdioTransport (NDJSON)", () => {
  function setup() {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const transport = createStdioTransport(stdout, stdin);
    const received: JsonRpcMessage[] = [];
    transport.onMessage((m) => received.push(m));
    const written: string[] = [];
    stdin.on("data", (c: Buffer) => written.push(c.toString("utf8")));
    return { stdout, stdin, transport, received, written };
  }

  it("parses one message per line", () => {
    const { stdout, received } = setup();
    stdout.write(`{"method":"turn/started","params":{"turnId":"t1"}}\n`);
    expect(received).toEqual([{ method: "turn/started", params: { turnId: "t1" } }]);
  });

  it("handles multiple messages in one chunk and a message split across chunks", () => {
    const { stdout, received } = setup();
    stdout.write(`{"id":1,"result":1}\n{"id":2,`);
    stdout.write(`"result":2}\n`);
    expect(received).toEqual([
      { id: 1, result: 1 },
      { id: 2, result: 2 },
    ]);
  });

  it("skips blank and unparseable lines without throwing", () => {
    const { stdout, received } = setup();
    stdout.write(`\n   \nnot json\n{"method":"ok"}\n`);
    expect(received).toEqual([{ method: "ok" }]);
  });

  it("drops parseable but non-object JSON (null / array / scalar)", () => {
    const { stdout, received } = setup();
    stdout.write(`null\n[]\n42\n"hi"\n{"method":"ok"}\n`);
    expect(received).toEqual([{ method: "ok" }]);
  });

  it("closes the transport when a single line exceeds the max length", () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const transport = createStdioTransport(stdout, stdin, { maxLineLength: 32 });
    const onClose = vi.fn();
    transport.onClose(onClose);
    stdout.write("x".repeat(64)); // no newline, exceeds the cap
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/exceeded 32 bytes/) }),
    );
  });

  it("serializes outbound messages as JSON + newline", () => {
    const { transport, written } = setup();
    transport.send({ id: 5, method: "turn/start", params: { x: 1 } });
    expect(written.join("")).toBe(`{"id":5,"method":"turn/start","params":{"x":1}}\n`);
  });

  it("surfaces a stdout error as a close with the error", () => {
    const { stdout, transport } = setup();
    const onClose = vi.fn();
    transport.onClose(onClose);
    stdout.emit("error", new Error("pipe broke"));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ message: "pipe broke" }));
  });

  it("routes a synchronous write failure through onClose instead of throwing", () => {
    const { stdin, transport } = setup();
    const onClose = vi.fn();
    transport.onClose(onClose);
    stdin.write = () => {
      throw new Error("EPIPE: broken pipe");
    };
    expect(() => transport.send({ method: "x" })).not.toThrow();
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ message: "EPIPE: broken pipe" }));
  });

  it("surfaces an async stdin error as a close (and does not crash)", () => {
    const { stdin, transport } = setup();
    const onClose = vi.fn();
    transport.onClose(onClose);
    // No "error" listener of our own — the transport's listener prevents an
    // unhandled-error throw and routes it through onClose.
    stdin.emit("error", new Error("pipe closed"));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ message: "pipe closed" }));
  });

  it("emits onClose at most once even when error then close/end fire", () => {
    const { stdout, transport } = setup();
    const onClose = vi.fn();
    transport.onClose(onClose);
    stdout.emit("error", new Error("pipe broke"));
    stdout.emit("close");
    stdout.emit("end");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("detaches all stdout listeners on close (no leak, no further dispatch)", () => {
    const { stdout, transport, received } = setup();
    transport.close();
    expect(stdout.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stdout.listenerCount("close")).toBe(0);
    expect(stdout.listenerCount("end")).toBe(0);
    // Late data after close is not dispatched.
    stdout.emit("data", Buffer.from(`{"method":"late"}\n`));
    expect(received).toEqual([]);
  });
});
