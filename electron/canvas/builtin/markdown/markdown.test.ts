// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { appendContent, createDoc, MAX_CONTENT_LENGTH, setContent } from "./doc.mjs";
import { createMarkdownDefinition } from "./definition.mjs";
import { createCanvasHostRuntime, type HostTransport } from "../../host/runtime";
import type { HostToMainMessage, MainToHostMessage } from "../../host-protocol";

describe("doc.mjs — pure reducers", () => {
  it("setContent replaces the document", () => {
    expect(setContent({ content: "old" }, { content: "# New" }).doc).toEqual({ content: "# New" });
  });

  it("appendContent adds a blank-line separator only when the doc already has text", () => {
    expect(appendContent(createDoc(), { content: "first" }).doc.content).toBe("first");
    expect(appendContent({ content: "first" }, { content: "second" }).doc.content).toBe("first\n\nsecond");
    expect(appendContent({ content: "first\n" }, { content: "second" }).doc.content).toBe("first\n\nsecond");
  });

  it("rejects non-strings and oversized documents", () => {
    expect(() => setContent(createDoc(), { content: 5 as unknown as string })).toThrow(/string/);
    expect(() => setContent(createDoc(), { content: "x".repeat(MAX_CONTENT_LENGTH + 1) })).toThrow(/too large/);
    expect(() => appendContent({ content: "x".repeat(MAX_CONTENT_LENGTH) }, { content: "y" })).toThrow(/too large/);
  });
});

function createFakeTransport(): HostTransport & { sent: HostToMainMessage[]; emit(m: MainToHostMessage): void } {
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

function boot() {
  const transport = createFakeTransport();
  createCanvasHostRuntime({
    definition: createMarkdownDefinition(z),
    transport,
    project: { id: "proj-1", path: "/tmp/proj-1" },
  });
  transport.emit({ type: "init", state: null, revision: 0 });
  return transport;
}

async function callTool(transport: ReturnType<typeof createFakeTransport>, tool: string, args: unknown, callId = "c1") {
  transport.emit({ type: "tool.call", callId, tool, args });
  await new Promise((resolve) => setImmediate(resolve));
  const result = transport.sent.find((m) => m.type === "tool.result" && m.callId === callId);
  if (!result || result.type !== "tool.result") throw new Error(`No tool.result for ${callId}`);
  return result;
}

describe("markdown CanvasServerDefinition — via the real host runtime", () => {
  it("get_document/append are approval:none; set_document (overwrite) is approval:ask", () => {
    const ready = boot().sent.find((m) => m.type === "ready") as { tools: { name: string; approval: string }[] };
    expect(Object.fromEntries(ready.tools.map((t) => [t.name, t.approval]))).toEqual({
      get_document: "none",
      append: "none",
      set_document: "ask",
    });
  });

  it("append then get_document round-trips and emits state.changed", async () => {
    const transport = boot();
    await callTool(transport, "append", { content: "# Title" });
    await callTool(transport, "append", { content: "body" }, "c2");
    expect(transport.sent.some((m) => m.type === "state.changed")).toBe(true);
    const doc = (await callTool(transport, "get_document", {}, "c3")).result;
    expect(doc).toEqual({ content: "# Title\n\nbody" });
  });

  it("a UI 'set' message replaces the document; malformed ones are logged, not thrown", async () => {
    const transport = boot();
    transport.emit({ type: "ui.message", message: { type: "set", content: "edited by user" } });
    expect((await callTool(transport, "get_document", {})).result).toEqual({ content: "edited by user" });

    expect(() => transport.emit({ type: "ui.message", message: { type: "set", content: 42 } })).not.toThrow();
    expect(transport.sent.some((m) => m.type === "log")).toBe(true);
  });
});
