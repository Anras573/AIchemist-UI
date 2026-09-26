// Pure state-transform functions for the kanban board — no SDK / zod
// dependency, so this module is importable both by `definition.mjs` (the
// real canvas, dogfooding `@aichemist/canvas` via `server.mjs`) and directly
// by tests, without needing the host's ESM loader hook.
//
// Board shape: `{ columns: { todo: Card[], doing: Card[], done: Card[] } }`.
// Card shape: `{ id, title, description }`.

import * as crypto from "node:crypto";

export const COLUMN_IDS = ["todo", "doing", "done"];
export const COLUMN_LABELS = { todo: "To do", doing: "Doing", done: "Done" };

export function isColumn(value) {
  return COLUMN_IDS.includes(value);
}

export function createBoard() {
  return { columns: { todo: [], doing: [], done: [] } };
}

/** Locates a card by id across every column. Returns null if not found. */
export function findCard(board, id) {
  for (const column of COLUMN_IDS) {
    const index = board.columns[column].findIndex((card) => card.id === id);
    if (index !== -1) return { card: board.columns[column][index], column, index };
  }
  return null;
}

/** Returns a new board with a fresh card appended to `column`. */
export function addCard(board, { column, title, description }) {
  if (!isColumn(column)) throw new Error(`Unknown column: ${column}`);
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed) throw new Error("A card needs a non-empty title");

  const card = { id: crypto.randomUUID(), title: trimmed, description: description?.trim() || undefined };
  const next = structuredClone(board);
  next.columns[column] = [...next.columns[column], card];
  return { board: next, card };
}

/**
 * Returns a new board with card `id` moved to column `to`, at `toIndex` (end
 * of the column when omitted or out of range). Throws if the card or column
 * doesn't exist. Moving a card to the same column it's already in still
 * re-orders it — needed for in-column drag reordering.
 */
export function moveCard(board, { id, to, toIndex }) {
  if (!isColumn(to)) throw new Error(`Unknown column: ${to}`);
  const found = findCard(board, id);
  if (!found) throw new Error(`Card not found: ${id}`);

  const next = structuredClone(board);
  const [card] = next.columns[found.column].splice(found.index, 1);
  const destination = next.columns[to];
  const insertAt = typeof toIndex === "number" && toIndex >= 0 && toIndex <= destination.length ? toIndex : destination.length;
  destination.splice(insertAt, 0, card);
  return { board: next, card };
}

/** Returns a new board with card `id`'s `title`/`description` patched (only the given fields). */
export function updateCard(board, { id, title, description }) {
  const found = findCard(board, id);
  if (!found) throw new Error(`Card not found: ${id}`);

  const next = structuredClone(board);
  const card = next.columns[found.column][found.index];
  if (typeof title === "string") {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("A card needs a non-empty title");
    card.title = trimmed;
  }
  if (typeof description === "string") card.description = description.trim() || undefined;
  return { board: next, card };
}

/** Returns a new board with card `id` removed. Throws if it doesn't exist. */
export function removeCard(board, { id }) {
  const found = findCard(board, id);
  if (!found) throw new Error(`Card not found: ${id}`);

  const next = structuredClone(board);
  next.columns[found.column].splice(found.index, 1);
  return { board: next };
}
