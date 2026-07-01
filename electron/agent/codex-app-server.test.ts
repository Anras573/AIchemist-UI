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
  const sent: JsonRpcMessage[] = [];
  const connClose = vi.fn();
  const transport: JsonRpcTransport = {
    send: (m) => sent.push(m),
    onMessage: (h) => { messageHandler = h; },
    onClose: () => {},
    close: vi.fn(),
  };
  const connector: AppServerConnector = (handlers) => ({
    peer: new JsonRpcPeer(transport, {
      onNotification: handlers.onNotification,
      onRequest: handlers.onRequest,
    }),
    close: connClose,
  });
  const client = new CodexAppServerClient(connector, onApproval);
  return {
    client,
    sent,
    connClose,
    inject: (m: JsonRpcMessage) => messageHandler(m),
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
    const p = h.client.startThread({ model: "gpt-5.1-codex", cwd: "/proj", approvalPolicy: "on-request" });
    expect(h.sent.at(-1)).toMatchObject({
      method: "thread/start",
      params: { model: "gpt-5.1-codex", cwd: "/proj", approvalPolicy: "on-request" },
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
    await expect(async () => {
      for await (const _ of h.client.runTurn("thr_1", "b")) void _;
    }).rejects.toThrow(/already in progress/);
    h.inject({ method: "turn/completed", params: {} });
    await first.done;
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
