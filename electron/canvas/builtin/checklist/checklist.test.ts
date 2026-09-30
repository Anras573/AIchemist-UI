// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { addItem, clearCompleted, createList, removeItem, toggleItem, updateItem } from "./list.mjs";
import { createChecklistDefinition } from "./definition.mjs";
import { createCanvasHostRuntime, type HostTransport } from "../../host/runtime";
import type { HostToMainMessage, MainToHostMessage } from "../../host-protocol";

describe("list.mjs — pure reducers", () => {
  it("addItem appends a trimmed, unchecked item and rejects empty text", () => {
    const { list, item } = addItem(createList(), { text: "  Buy milk  " });
    expect(list.items).toEqual([item]);
    expect(item).toMatchObject({ text: "Buy milk", done: false });
    expect(() => addItem(createList(), { text: "  " })).toThrow(/non-empty/);
  });

  it("toggleItem flips, or sets explicitly when done is given", () => {
    const { list, item } = addItem(createList(), { text: "x" });
    const flipped = toggleItem(list, { id: item.id }).list;
    expect(flipped.items[0].done).toBe(true);
    expect(toggleItem(flipped, { id: item.id, done: true }).list.items[0].done).toBe(true);
    expect(toggleItem(flipped, { id: item.id, done: false }).list.items[0].done).toBe(false);
    expect(() => toggleItem(list, { id: "nope" })).toThrow(/Item not found/);
  });

  it("updateItem changes text; removeItem removes; both throw for unknown ids", () => {
    const { list, item } = addItem(createList(), { text: "old" });
    expect(updateItem(list, { id: item.id, text: "new" }).list.items[0].text).toBe("new");
    expect(() => updateItem(list, { id: item.id, text: " " })).toThrow(/non-empty/);
    expect(removeItem(list, { id: item.id }).list.items).toEqual([]);
    expect(() => removeItem(list, { id: "nope" })).toThrow(/Item not found/);
  });

  it("clearCompleted drops only checked items and reports the count", () => {
    let list = createList();
    const a = addItem(list, { text: "a" });
    list = addItem(a.list, { text: "b" }).list;
    list = toggleItem(list, { id: a.item.id }).list;
    const result = clearCompleted(list);
    expect(result.removed).toBe(1);
    expect(result.list.items.map((i: { text: string }) => i.text)).toEqual(["b"]);
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

const PROJECT = { id: "proj-1", path: "/tmp/proj-1" };

function boot() {
  const transport = createFakeTransport();
  createCanvasHostRuntime({ definition: createChecklistDefinition(z), transport, project: PROJECT });
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

describe("checklist CanvasServerDefinition — via the real host runtime", () => {
  it("declares read/add/check tools as approval:none and destructive ones as approval:ask", () => {
    const transport = boot();
    const ready = transport.sent.find((m) => m.type === "ready") as { tools: { name: string; approval: string }[] };
    expect(Object.fromEntries(ready.tools.map((t) => [t.name, t.approval]))).toEqual({
      get_list: "none",
      add_item: "none",
      set_done: "none",
      update_item: "ask",
      remove_item: "ask",
      clear_completed: "ask",
    });
  });

  it("add_item → set_done → get_list round trip, emitting state.changed", async () => {
    const transport = boot();
    const added = await callTool(transport, "add_item", { text: "Ship it" });
    expect(added.ok).toBe(true);
    const id = (added.result as { item: { id: string } }).item.id;
    expect(transport.sent.some((m) => m.type === "state.changed")).toBe(true);

    await callTool(transport, "set_done", { id }, "c2");
    const list = (await callTool(transport, "get_list", {}, "c3")).result as ReturnType<typeof createList>;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ text: "Ship it", done: true });
  });

  it("clear_completed reports how many were removed", async () => {
    const transport = boot();
    const a = await callTool(transport, "add_item", { text: "a" });
    await callTool(transport, "add_item", { text: "b" }, "c2");
    await callTool(transport, "set_done", { id: (a.result as { item: { id: string } }).item.id }, "c3");
    const cleared = await callTool(transport, "clear_completed", {}, "c4");
    expect(cleared.result).toEqual({ ok: true, removed: 1 });
  });

  it("an unknown id surfaces a tool error", async () => {
    const result = await callTool(boot(), "set_done", { id: "nope" });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Item not found/);
  });

  it("UI messages use the same reducers, visible to the next get_list; malformed ones are logged", async () => {
    const transport = boot();
    transport.emit({ type: "ui.message", message: { type: "add", text: "From UI" } });
    const list = (await callTool(transport, "get_list", {})).result as ReturnType<typeof createList>;
    expect(list.items[0].text).toBe("From UI");

    expect(() => transport.emit({ type: "ui.message", message: { type: "toggle", id: "missing" } })).not.toThrow();
    expect(transport.sent.some((m) => m.type === "log")).toBe(true);
  });
});
