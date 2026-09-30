// Pure state-transform functions for the checklist canvas — no SDK / zod
// dependency (importable directly by tests). State: `{ items: Item[] }`,
// Item: `{ id, text, done }`.

import * as crypto from "node:crypto";

export function createList() {
  return { items: [] };
}

export function findItem(list, id) {
  const index = list.items.findIndex((item) => item.id === id);
  return index === -1 ? null : { item: list.items[index], index };
}

export function addItem(list, { text }) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) throw new Error("An item needs non-empty text");
  const item = { id: crypto.randomUUID(), text: trimmed, done: false };
  return { list: { items: [...list.items, item] }, item };
}

/** Sets `done` explicitly when given, otherwise flips it. */
export function toggleItem(list, { id, done }) {
  const found = findItem(list, id);
  if (!found) throw new Error(`Item not found: ${id}`);
  const next = structuredClone(list);
  const item = next.items[found.index];
  item.done = typeof done === "boolean" ? done : !item.done;
  return { list: next, item };
}

export function updateItem(list, { id, text }) {
  const found = findItem(list, id);
  if (!found) throw new Error(`Item not found: ${id}`);
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) throw new Error("An item needs non-empty text");
  const next = structuredClone(list);
  next.items[found.index].text = trimmed;
  return { list: next, item: next.items[found.index] };
}

export function removeItem(list, { id }) {
  const found = findItem(list, id);
  if (!found) throw new Error(`Item not found: ${id}`);
  const next = structuredClone(list);
  next.items.splice(found.index, 1);
  return { list: next };
}

export function clearCompleted(list) {
  const kept = list.items.filter((item) => !item.done);
  return { list: { items: kept }, removed: list.items.length - kept.length };
}
