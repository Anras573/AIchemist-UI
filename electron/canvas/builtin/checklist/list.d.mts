// Ambient type declaration for list.mjs (see ../kanban/board.d.mts for why).
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}
export interface Checklist {
  items: ChecklistItem[];
}
export function createList(): Checklist;
export function findItem(list: Checklist, id: string): { item: ChecklistItem; index: number } | null;
export function addItem(list: Checklist, args: { text: string }): { list: Checklist; item: ChecklistItem };
export function toggleItem(list: Checklist, args: { id: string; done?: boolean }): { list: Checklist; item: ChecklistItem };
export function updateItem(list: Checklist, args: { id: string; text: string }): { list: Checklist; item: ChecklistItem };
export function removeItem(list: Checklist, args: { id: string }): { list: Checklist };
export function clearCompleted(list: Checklist): { list: Checklist; removed: number };
