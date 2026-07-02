// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { JsonRpcPeer, type JsonRpcMessage, type JsonRpcTransport } from "./jsonrpc";
import {
  CodexAppServerClient,
  denyAllApprovals,
  type AppServerConnector,
  type AppServerTurnEvent,
  type AppServerApprovalHandler,
} from "./codex-app-server";

const flush = () => new Promise((r) => setImmediate(r));

/**
 * Build a client over a real JsonRpcPeer + fake transport, so the test can
 * observe what the client sends and simulate the server side (responses,
 * notifications, inbound approval requests).
 */
function makeClient(onApproval?: AppServerApprovalHandler) {
  let messageHandler: (m: JsonRpcMessage) => void = () => {};
  let transportCloseHandler: ((err?: Error) => void) | null = null;
  const sent: JsonRpcMessage[] = [];
  const connClose = vi.fn();
  const transport: JsonRpcTransport = {
    send: (m) => sent.push(m),
    onMessage: (h) => { messageHandler = h; },
    onClose: (h) => { transportCloseHandler = h; },
    close: vi.fn(),
  };
  const connector: AppServerConnector = (handlers) => ({
    peer: new JsonRpcPeer(transport, {
      onNotification: handlers.onNotification,
      onRequest: handlers.onRequest,
      onClose: handlers.onClose,
    }),
    close: connClose,
  });
  const client = new CodexAppServerClient(connector, onApproval);
  return {
    client,
    sent,
    connClose,
    inject: (m: JsonRpcMessage) => messageHandler(m),
    /** Simulate the underlying transport/process closing. */
    triggerClose: (err?: Error) => transportCloseHandler?.(err),
    respondTo: (method: string, result: unknown) => {
      const req = [...sent].reverse().find((m) => m.method === method);
      if (!req) throw new Error(`no sent request for ${method}`);
      messageHandler({ id: req.id, result });
    },
    rejectRequest: (method: string, error: { code: number; message: string }) => {
      const req = [...sent].reverse().find((m) => m.method === method);
      if (!req) throw new Error(`no sent request for ${method}`);
      messageHandler({ id: req.id, error });
    },
  };
}

/** Iterate a turn to completion, collecting its events. */
function collectTurn(gen: AsyncGenerator<AppServerTurnEvent>) {
  const events: AppServerTurnEvent[] = [];
  const done = (async () => {
    for await (const e of gen) events.push(e);
  })();
  return { events, done };
}

describe("CodexAppServerClient", () => {
  it("runs the initialize handshake", async () => {
    const h = makeClient();
    const p = h.client.initialize();
    expect(h.sent.at(-1)).toMatchObject({ method: "initialize" });
    h.respondTo("initialize", {});
    await expect(p).resolves.toBeUndefined();
  });

  it("starts a thread and returns its id", async () => {
    const h = makeClient();
    const p = h.client.startThread({
      model: "gpt-5.1-codex",
      cwd: "/proj",
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
    });
    expect(h.sent.at(-1)).toMatchObject({
      method: "thread/start",
      params: { model: "gpt-5.1-codex", cwd: "/proj", approvalPolicy: "on-request", sandbox: "workspaceWrite" },
    });
    h.respondTo("thread/start", { thread: { id: "thr_123" } });
    await expect(p).resolves.toBe("thr_123");
  });

  it("throws if thread/start returns no thread id", async () => {
    const h = makeClient();
    const p = h.client.startThread();
    h.respondTo("thread/start", { thread: {} });
    await expect(p).rejects.toThrow(/no thread id/);
  });

  it("streams a turn's lifecycle and attaches the latest usage to turn.completed", async () => {
    const h = makeClient();
    const { events, done } = collectTurn(h.client.runTurn("thr_1", "fix the build"));
    await flush();
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: { threadId: "thr_1", input: [{ type: "text", text: "fix the build" }] },
    });

    h.inject({ method: "turn/started" });
    h.inject({ method: "item/started", params: { item: { type: "commandExecution", command: "ls" } } });
    h.inject({ method: "item/completed", params: { item: { type: "agentMessage", text: "done" } } });
    h.inject({ method: "thread/tokenUsage/updated", params: { input: 5, output: 3 } });
    h.inject({ method: "turn/completed", params: { turn: { status: "completed" } } });

    await done;
    expect(events).toEqual([
      { type: "turn.started" },
      { type: "item.started", item: { type: "commandExecution", command: "ls" } },
      { type: "item.completed", item: { type: "agentMessage", text: "done" } },
      { type: "turn.completed", usage: { input: 5, output: 3 } },
    ]);
  });

  it("prefers usage carried on turn/completed over the streamed snapshot", async () => {
    const h = makeClient();
    const { events, done } = collectTurn(h.client.runTurn("thr_1", "x"));
    await flush();
    h.inject({ method: "thread/tokenUsage/updated", params: { input: 5, output: 3 } });
    h.inject({ method: "turn/completed", params: { turn: { status: "completed", usage: { input: 9, output: 4 } } } });
    await done;
    expect(events).toEqual([{ type: "turn.completed", usage: { input: 9, output: 4 } }]);
  });

  it("maps a turn/completed carrying an error to turn.failed", async () => {
    const h = makeClient();
    const { events, done } = collectTurn(h.client.runTurn("thr_1", "x"));
    await flush();
    h.inject({ method: "turn/completed", params: { turn: { error: { message: "model exploded" } } } });
    await done;
    expect(events).toEqual([{ type: "turn.failed", error: { message: "model exploded" } }]);
  });

  it("maps a turn/failed notification to turn.failed", async () => {
    const h = makeClient();
    const { events, done } = collectTurn(h.client.runTurn("thr_1", "x"));
    await flush();
    h.inject({ method: "turn/failed", params: { error: "boom" } });
    await done;
    expect(events).toEqual([{ type: "turn.failed", error: { message: "boom" } }]);
  });

  it("fails the turn when turn/start is rejected", async () => {
    const h = makeClient();
    const { events, done } = collectTurn(h.client.runTurn("bad-thread", "x"));
    await flush();
    h.rejectRequest("turn/start", { code: -32602, message: "unknown thread" });
    await done;
    expect(events).toEqual([{ type: "turn.failed", error: { message: "unknown thread" } }]);
  });

  it("routes an inbound approval request to the handler and replies with its result", async () => {
    const onApproval = vi.fn(async () => ({ decision: "allow", scope: "turn" }));
    const h = makeClient(onApproval);
    h.inject({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thr_1", itemId: "call_1", command: "rm -rf x" },
    });
    await flush();
    expect(onApproval).toHaveBeenCalledWith({
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thr_1", itemId: "call_1", command: "rm -rf x" },
    });
    expect(h.sent).toContainEqual({ id: 99, result: { decision: "allow", scope: "turn" } });
  });

  it("denies by default", async () => {
    const h = makeClient(); // default denyAllApprovals
    h.inject({ id: 7, method: "item/commandExecution/requestApproval", params: {} });
    await flush();
    expect(h.sent).toContainEqual({ id: 7, result: { decision: "deny" } });
    await expect(denyAllApprovals({ method: "x", params: {} })).resolves.toEqual({ decision: "deny" });
  });

  it("rejects a second concurrent turn", async () => {
    const h = makeClient();
    const first = collectTurn(h.client.runTurn("thr_1", "a"));
    await flush();
    await expect(
      (async () => {
        for await (const _ of h.client.runTurn("thr_1", "b")) void _;
      })(),
    ).rejects.toThrow(/already in progress/);
    h.inject({ method: "turn/completed", params: {} });
    await first.done;
  });

  it("ignores a token-usage update with no active turn (no cross-turn leak)", async () => {
    const h = makeClient();
    h.inject({ method: "thread/tokenUsage/updated", params: { stale: true } }); // no active turn
    const { events, done } = collectTurn(h.client.runTurn("thr_1", "x"));
    await flush();
    h.inject({ method: "turn/completed", params: {} });
    await done;
    // The pre-turn usage must not attach to this turn.
    expect(events).toEqual([{ type: "turn.completed", usage: null }]);
  });

  it("a late turn/start response from a prior turn does not clobber the current turn's id", async () => {
    const h = makeClient();
    // Turn A: completes before its turn/start response arrives.
    const a = collectTurn(h.client.runTurn("thr_1", "a"));
    await flush();
    const aReq = [...h.sent].reverse().find((m) => m.method === "turn/start")!;
    h.inject({ method: "turn/completed", params: {} });
    await a.done;

    // Turn B: capture its id, then deliver A's late response (clobber attempt).
    const gen = h.client.runTurn("thr_1", "b");
    const first = gen.next();
    await flush();
    h.respondTo("turn/start", { turn: { id: "turn_B" } });
    h.inject({ id: aReq.id, result: { turn: { id: "turn_A" } } }); // late A response
    await flush();
    h.inject({ method: "turn/started" });
    await first;

    await gen.return(undefined); // abandon B → must interrupt turn_B, not turn_A
    await flush();
    expect(h.sent).toContainEqual(
      expect.objectContaining({ method: "turn/interrupt", params: { threadId: "thr_1", turnId: "turn_B" } }),
    );
    expect(h.sent).not.toContainEqual(
      expect.objectContaining({ method: "turn/interrupt", params: { threadId: "thr_1", turnId: "turn_A" } }),
    );
  });

  it("fails the active turn when the peer/connection closes (process died)", async () => {
    const h = makeClient();
    const { events, done } = collectTurn(h.client.runTurn("thr_1", "x"));
    await flush();
    h.triggerClose(new Error("codex app-server exited (code 1)"));
    await done;
    expect(events).toEqual([
      { type: "turn.failed", error: { message: "codex app-server exited (code 1)" } },
    ]);
  });

  it("interrupts the still-running server turn when the consumer breaks early", async () => {
    const h = makeClient();
    const gen = h.client.runTurn("thr_1", "x");
    const first = gen.next();
    await flush();
    h.respondTo("turn/start", { turn: { id: "turn_9" } }); // captures the turn id
    await flush();
    h.inject({ method: "turn/started" });
    expect((await first).value).toEqual({ type: "turn.started" });

    await gen.return(undefined); // consumer breaks → finally interrupts
    await flush();
    expect(h.sent).toContainEqual(
      expect.objectContaining({
        method: "turn/interrupt",
        params: { threadId: "thr_1", turnId: "turn_9" },
      }),
    );
  });

  it("interrupts once the turn id arrives if the consumer abandoned before it did", async () => {
    const h = makeClient();
    const gen = h.client.runTurn("thr_1", "x");
    const first = gen.next();
    await flush();
    // A notification arrives before the turn/start response, so the consumer
    // gets an event and can break — while turnId is still null.
    h.inject({ method: "turn/started" });
    expect((await first).value).toEqual({ type: "turn.started" });

    await gen.return(undefined); // abandon before the turn id is known
    await flush();
    expect(h.sent).not.toContainEqual(expect.objectContaining({ method: "turn/interrupt" }));

    // The late turn/start response should now trigger the deferred interrupt.
    h.respondTo("turn/start", { turn: { id: "turn_late" } });
    await flush();
    expect(h.sent).toContainEqual(
      expect.objectContaining({
        method: "turn/interrupt",
        params: { threadId: "thr_1", turnId: "turn_late" },
      }),
    );
  });

  it("close() ends the active turn and tears down the connection", async () => {
    const h = makeClient();
    const { events, done } = collectTurn(h.client.runTurn("thr_1", "x"));
    await flush();
    h.inject({ method: "turn/started" });
    h.client.close();
    await done; // the generator returns when the queue is ended
    expect(events).toEqual([{ type: "turn.started" }]);
    expect(h.connClose).toHaveBeenCalled();
  });
});
