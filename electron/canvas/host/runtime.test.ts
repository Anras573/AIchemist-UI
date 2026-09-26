import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import type { HostToMainMessage, MainToHostMessage } from "../host-protocol";
import { createCanvasHostRuntime, type HostTransport } from "./runtime";
import { defineCanvas } from "./sdk";

/** A transport whose `send`/received-message flow is fully inspectable. */
function createFakeTransport(): HostTransport & {
  sent: HostToMainMessage[];
  emit(message: MainToHostMessage): void;
} {
  const sent: HostToMainMessage[] = [];
  let handler: ((message: MainToHostMessage) => void) | null = null;
  return {
    sent,
    send: (message) => sent.push(message),
    onMessage: (h) => {
      handler = h;
    },
    emit: (message) => handler?.(message),
  };
}

const PROJECT = { id: "proj-1", path: "/tmp/proj-1" };

describe("createCanvasHostRuntime — init and tool listing", () => {
  it("replies to init with the persisted state/revision and the tool list", () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({
      initialState: { count: 0 },
      tools: {
        get_count: {
          description: "Return the count",
          input: z.object({}),
          handler: (_args, ctx) => ctx.state.get(),
        },
        bump: {
          description: "Bump the count",
          input: z.object({}),
          approval: "none",
          handler: (_args, ctx) => ctx.state.update((s: any) => ({ count: s.count + 1 })),
        },
      },
    });

    const runtime = createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: { count: 5 }, revision: 3 });

    expect(runtime.getState()).toEqual({ count: 5 });
    expect(runtime.getRevision()).toBe(3);
    expect(transport.sent).toEqual([
      {
        type: "ready",
        tools: [
          { name: "get_count", description: "Return the count", approval: "ask" },
          { name: "bump", description: "Bump the count", approval: "none" },
        ],
      },
    ]);
  });

  it("falls back to the definition's initialState when init carries no persisted state", () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({ initialState: { seeded: true } });
    const runtime = createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });
    expect(runtime.getState()).toEqual({ seeded: true });
  });
});

describe("createCanvasHostRuntime — ctx.state semantics", () => {
  it("set() replaces state, bumps revision, and emits state.changed", async () => {
    const transport = createFakeTransport();
    let capturedCtx: any;
    const definition = defineCanvas({
      tools: {
        replace: {
          description: "Replace state",
          input: z.object({ value: z.number() }),
          handler: (args, ctx) => {
            capturedCtx = ctx;
            ctx.state.set({ value: args.value });
            return { ok: true };
          },
        },
      },
    });
    const runtime = createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: { value: 0 }, revision: 0 });
    transport.emit({ type: "tool.call", callId: "1", tool: "replace", args: { value: 42 } });
    await vi.waitFor(() => expect(runtime.getRevision()).toBe(1));

    expect(runtime.getState()).toEqual({ value: 42 });
    expect(transport.sent).toContainEqual({ type: "state.changed", state: { value: 42 }, revision: 1 });
    expect(capturedCtx.project).toEqual(PROJECT);
  });

  it("update() derives the next state from the current one and bumps revision once per call", async () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({
      tools: {
        inc: {
          description: "Increment",
          input: z.object({}),
          handler: (_args, ctx) => {
            ctx.state.update((s: any) => ({ count: s.count + 1 }));
            return ctx.state.get();
          },
        },
      },
    });
    const runtime = createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: { count: 0 }, revision: 0 });
    transport.emit({ type: "tool.call", callId: "1", tool: "inc", args: {} });
    transport.emit({ type: "tool.call", callId: "2", tool: "inc", args: {} });
    await vi.waitFor(() => expect(runtime.getRevision()).toBe(2));

    expect(runtime.getState()).toEqual({ count: 2 });
    const results = transport.sent.filter((m) => m.type === "tool.result");
    expect(results).toEqual([
      { type: "tool.result", callId: "1", ok: true, result: { count: 1 } },
      { type: "tool.result", callId: "2", ok: true, result: { count: 2 } },
    ]);
  });
});

describe("createCanvasHostRuntime — tool calls", () => {
  it("returns a tool.result error for an unknown tool", async () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({ tools: {} });
    createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });
    transport.emit({ type: "tool.call", callId: "1", tool: "missing", args: {} });
    await vi.waitFor(() =>
      expect(transport.sent).toContainEqual({
        type: "tool.result",
        callId: "1",
        ok: false,
        error: { message: 'Unknown tool: missing' },
      })
    );
  });

  it("returns a tool.result error when args fail zod validation", async () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({
      tools: {
        strict: {
          description: "Requires a string",
          input: z.object({ name: z.string() }),
          handler: () => ({ ok: true }),
        },
      },
    });
    createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });
    transport.emit({ type: "tool.call", callId: "1", tool: "strict", args: { name: 42 } });

    await vi.waitFor(() => {
      const result = transport.sent.find((m) => m.type === "tool.result") as any;
      expect(result?.ok).toBe(false);
      expect(result?.error.message).toContain("Invalid input");
    });
  });

  it("turns a synchronously-throwing handler into a tool.result error, not a crash", async () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({
      tools: {
        boom: {
          description: "Throws",
          input: z.object({}),
          handler: () => {
            throw new Error("kaboom");
          },
        },
      },
    });
    createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });
    transport.emit({ type: "tool.call", callId: "1", tool: "boom", args: {} });

    await vi.waitFor(() =>
      expect(transport.sent).toContainEqual({
        type: "tool.result",
        callId: "1",
        ok: false,
        error: { message: "kaboom" },
      })
    );
  });

  it("turns a rejecting async handler into a tool.result error", async () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({
      tools: {
        boom: {
          description: "Rejects",
          input: z.object({}),
          handler: async () => {
            throw new Error("async kaboom");
          },
        },
      },
    });
    createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });
    transport.emit({ type: "tool.call", callId: "1", tool: "boom", args: {} });

    await vi.waitFor(() =>
      expect(transport.sent).toContainEqual({
        type: "tool.result",
        callId: "1",
        ok: false,
        error: { message: "async kaboom" },
      })
    );
  });
});

describe("createCanvasHostRuntime — tool-call timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("errors a hanging handler after the default 60s timeout", async () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({
      tools: {
        hang: {
          description: "Never resolves",
          input: z.object({}),
          handler: () => new Promise(() => {}),
        },
      },
    });
    createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });
    transport.emit({ type: "tool.call", callId: "1", tool: "hang", args: {} });

    await vi.advanceTimersByTimeAsync(60_000);

    const result = transport.sent.find((m) => m.type === "tool.result") as any;
    expect(result?.ok).toBe(false);
    expect(result?.error.message).toContain('Tool "hang" timed out after 60000ms');
  });

  it("honors a per-tool timeoutMs override instead of the default", async () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({
      tools: {
        hang: {
          description: "Never resolves",
          input: z.object({}),
          timeoutMs: 5_000,
          handler: () => new Promise(() => {}),
        },
      },
    });
    createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });
    transport.emit({ type: "tool.call", callId: "1", tool: "hang", args: {} });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(transport.sent.find((m) => m.type === "tool.result")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    const result = transport.sent.find((m) => m.type === "tool.result") as any;
    expect(result?.ok).toBe(false);
    expect(result?.error.message).toContain("timed out after 5000ms");
  });

  it("does not error a handler that resolves before its timeout", async () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({
      tools: {
        slow: {
          description: "Resolves just in time",
          input: z.object({}),
          timeoutMs: 1_000,
          handler: () => new Promise((resolve) => setTimeout(() => resolve("done"), 500)),
        },
      },
    });
    createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });
    transport.emit({ type: "tool.call", callId: "1", tool: "slow", args: {} });

    await vi.advanceTimersByTimeAsync(500);
    expect(transport.sent).toContainEqual({ type: "tool.result", callId: "1", ok: true, result: "done" });
  });
});

describe("createCanvasHostRuntime — ctx.ui and onUiMessage", () => {
  it("ctx.ui.send() pushes a ui.message to main", async () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({
      tools: {
        notify: {
          description: "Push a UI message",
          input: z.object({}),
          handler: (_args, ctx) => {
            ctx.ui.send({ kind: "toast", text: "hi" });
            return { ok: true };
          },
        },
      },
    });
    createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });
    transport.emit({ type: "tool.call", callId: "1", tool: "notify", args: {} });

    await vi.waitFor(() =>
      expect(transport.sent).toContainEqual({ type: "ui.message", message: { kind: "toast", text: "hi" } })
    );
  });

  it("routes an inbound ui.message to onUiMessage with ctx", async () => {
    const onUiMessage = vi.fn(async (message: unknown, ctx: any) => {
      ctx.state.set({ lastMessage: message });
    });
    const transport = createFakeTransport();
    const definition = defineCanvas({ onUiMessage });
    const runtime = createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });
    transport.emit({ type: "ui.message", message: { type: "click", id: "card-1" } });

    await vi.waitFor(() => expect(runtime.getState()).toEqual({ lastMessage: { type: "click", id: "card-1" } }));
    expect(onUiMessage).toHaveBeenCalledWith({ type: "click", id: "card-1" }, expect.anything());
  });

  it("is a no-op when the definition declares no onUiMessage", () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({});
    expect(() => {
      createCanvasHostRuntime({ definition, transport, project: PROJECT });
      transport.emit({ type: "init", state: null, revision: 0 });
      transport.emit({ type: "ui.message", message: { anything: true } });
    }).not.toThrow();
  });
});

describe("createCanvasHostRuntime — ctx.agent.send", () => {
  it("forwards to transport as an agent.send message", async () => {
    const transport = createFakeTransport();
    const definition = defineCanvas({
      tools: {
        ask: {
          description: "Ask the agent to do something",
          input: z.object({}),
          handler: async (_args, ctx) => {
            await ctx.agent.send("please triage this", { sessionId: "s1" });
            return { ok: true };
          },
        },
      },
    });
    createCanvasHostRuntime({ definition, transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });
    transport.emit({ type: "tool.call", callId: "1", tool: "ask", args: {} });

    await vi.waitFor(() =>
      expect(transport.sent).toContainEqual({ type: "agent.send", text: "please triage this", sessionId: "s1" })
    );
  });
});
