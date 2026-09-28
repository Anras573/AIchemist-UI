// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { addCard, COLUMN_IDS, createBoard, findCard, moveCard, removeCard, updateCard } from "./board.mjs";
import { createKanbanDefinition } from "./definition.mjs";
import { createCanvasHostRuntime, type HostTransport } from "../../host/runtime";
import type { HostToMainMessage, MainToHostMessage } from "../../host-protocol";

// ─── board.mjs — pure reducers ───────────────────────────────────────────────

describe("board.mjs", () => {
  it("creates an empty board with all three columns", () => {
    const board = createBoard();
    expect(board.columns).toEqual({ todo: [], doing: [], done: [] });
  });

  it("addCard appends a trimmed card to the given column and returns it", () => {
    const { board, card } = addCard(createBoard(), { column: "todo", title: "  Write tests  ", description: " ok " });
    expect(board.columns.todo).toEqual([card]);
    expect(card.title).toBe("Write tests");
    expect(card.description).toBe("ok");
    expect(typeof card.id).toBe("string");
  });

  it("addCard rejects an unknown column or an empty title", () => {
    expect(() => addCard(createBoard(), { column: "someday", title: "x" })).toThrow(/Unknown column/);
    expect(() => addCard(createBoard(), { column: "todo", title: "   " })).toThrow(/non-empty title/);
  });

  it("moveCard relocates a card from one column to another", () => {
    const { board: withCard, card } = addCard(createBoard(), { column: "todo", title: "Ship it" });
    const { board: moved } = moveCard(withCard, { id: card.id, to: "done" });
    expect(moved.columns.todo).toEqual([]);
    expect(moved.columns.done.map((c) => c.id)).toEqual([card.id]);
  });

  it("moveCard reorders within the same column via toIndex", () => {
    let board = createBoard();
    board = addCard(board, { column: "todo", title: "A" }).board;
    board = addCard(board, { column: "todo", title: "B" }).board;
    const [a] = board.columns.todo;
    const moved = moveCard(board, { id: a.id, to: "todo", toIndex: 1 }).board;
    expect(moved.columns.todo.map((c) => c.title)).toEqual(["B", "A"]);
  });

  it("moveCard throws for an unknown card id or column", () => {
    expect(() => moveCard(createBoard(), { id: "missing", to: "done" })).toThrow(/Card not found/);
    const { board } = addCard(createBoard(), { column: "todo", title: "x" });
    const [card] = board.columns.todo;
    expect(() => moveCard(board, { id: card.id, to: "backlog" })).toThrow(/Unknown column/);
  });

  it("updateCard patches only the given fields", () => {
    const { board, card } = addCard(createBoard(), { column: "todo", title: "Old", description: "d" });
    const updated = updateCard(board, { id: card.id, title: "New" }).board;
    const found = findCard(updated, card.id)!;
    expect(found.card.title).toBe("New");
    expect(found.card.description).toBe("d");
  });

  it("removeCard removes the card and throws for an unknown id", () => {
    const { board, card } = addCard(createBoard(), { column: "todo", title: "x" });
    const removed = removeCard(board, { id: card.id }).board;
    expect(findCard(removed, card.id)).toBeNull();
    expect(() => removeCard(removed, { id: card.id })).toThrow(/Card not found/);
  });

  it("COLUMN_IDS is exactly todo/doing/done, in order", () => {
    expect(COLUMN_IDS).toEqual(["todo", "doing", "done"]);
  });
});

// ─── definition.mjs — the real tool/state wiring, run through the actual host runtime ───

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

/** The handler runs through an async `Promise.resolve().then(...)` chain (see runtime.ts), so the reply lands a tick after `emit()` returns. */
async function callTool(transport: ReturnType<typeof createFakeTransport>, tool: string, args: unknown, callId = "c1") {
  transport.emit({ type: "tool.call", callId, tool, args });
  await new Promise((resolve) => setImmediate(resolve));
  const result = transport.sent.find((m) => m.type === "tool.result" && m.callId === callId);
  if (!result || result.type !== "tool.result") throw new Error(`No tool.result for ${callId}`);
  return result;
}

describe("kanban CanvasServerDefinition — via the real host runtime", () => {
  it("declares get_board/add_card/move_card as approval:none and update_card/remove_card as approval:ask", () => {
    const transport = createFakeTransport();
    createCanvasHostRuntime({ definition: createKanbanDefinition(z), transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });

    const ready = transport.sent.find((m) => m.type === "ready");
    expect(ready?.type).toBe("ready");
    const approvals = Object.fromEntries((ready as { tools: { name: string; approval: string }[] }).tools.map((t) => [t.name, t.approval]));
    expect(approvals).toEqual({
      get_board: "none",
      add_card: "none",
      move_card: "none",
      update_card: "ask",
      remove_card: "ask",
    });
  });

  it("starts with an empty board and get_board reflects it", async () => {
    const transport = createFakeTransport();
    createCanvasHostRuntime({ definition: createKanbanDefinition(z), transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });

    const result = await callTool(transport, "get_board", {});
    expect(result.ok).toBe(true);
    expect(result.result).toEqual(createBoard());
  });

  it("a tool call that mutates state emits state.changed with the new board, immediately", async () => {
    const transport = createFakeTransport();
    createCanvasHostRuntime({ definition: createKanbanDefinition(z), transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });

    const add = await callTool(transport, "add_card", { column: "todo", title: "Ship kanban" });
    expect(add.ok).toBe(true);

    const changed = transport.sent.find((m) => m.type === "state.changed");
    expect(changed?.type).toBe("state.changed");
    const board = (changed as { state: ReturnType<typeof createBoard> }).state;
    expect(board.columns.todo).toHaveLength(1);
    expect(board.columns.todo[0].title).toBe("Ship kanban");
  });

  it("move_card moves the card and the next get_board reflects it — the agent's read-your-own-write loop", async () => {
    const transport = createFakeTransport();
    createCanvasHostRuntime({ definition: createKanbanDefinition(z), transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });

    const added = await callTool(transport, "add_card", { column: "todo", title: "Card A" });
    const cardId = (added.result as { card: { id: string } }).card.id;

    const moved = await callTool(transport, "move_card", { id: cardId, to: "done" }, "c2");
    expect(moved.ok).toBe(true);

    const board = (await callTool(transport, "get_board", {}, "c3")).result as ReturnType<typeof createBoard>;
    expect(board.columns.todo).toEqual([]);
    expect(board.columns.done.map((c) => c.id)).toEqual([cardId]);
  });

  it("move_card on an unknown id surfaces a tool error rather than a generic failure", async () => {
    const transport = createFakeTransport();
    createCanvasHostRuntime({ definition: createKanbanDefinition(z), transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });

    const result = await callTool(transport, "move_card", { id: "nope", to: "done" });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Card not found/);
  });

  it("a UI message applies the same reducer as the matching tool, visible on the next get_board", async () => {
    const transport = createFakeTransport();
    createCanvasHostRuntime({ definition: createKanbanDefinition(z), transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });

    // The user drags a card via the UI (no tool call at all) ...
    transport.emit({ type: "ui.message", message: { type: "add", column: "doing", title: "From the UI" } });

    // ... and the agent's next get_board call sees it.
    const board = (await callTool(transport, "get_board", {})).result as ReturnType<typeof createBoard>;
    expect(board.columns.doing).toHaveLength(1);
    expect(board.columns.doing[0].title).toBe("From the UI");
  });

  it("a malformed UI message is swallowed (logged) rather than crashing the host", () => {
    const transport = createFakeTransport();
    createCanvasHostRuntime({ definition: createKanbanDefinition(z), transport, project: PROJECT });
    transport.emit({ type: "init", state: null, revision: 0 });

    expect(() => transport.emit({ type: "ui.message", message: { type: "move", id: "does-not-exist", to: "done" } })).not.toThrow();
    const logged = transport.sent.find((m) => m.type === "log");
    expect(logged).toBeTruthy();
  });
});
