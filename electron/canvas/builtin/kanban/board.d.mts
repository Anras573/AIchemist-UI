// Ambient type declaration for board.mjs (plain JS, no build step — it's
// loaded as-is by the canvas host and imported directly by tests). Kept in
// sync by hand; there is no codegen step for a file this small.
export type ColumnId = "todo" | "doing" | "done";

export interface Card {
  id: string;
  title: string;
  description?: string;
}

export interface Board {
  columns: Record<ColumnId, Card[]>;
}

export const COLUMN_IDS: readonly ColumnId[];
export const COLUMN_LABELS: Record<ColumnId, string>;

export function isColumn(value: unknown): value is ColumnId;
export function createBoard(): Board;
export function findCard(board: Board, id: string): { card: Card; column: ColumnId; index: number } | null;
// `column`/`to` are typed as `string`, not `ColumnId`: nothing at the type
// level guarantees a caller passed a valid column (an `onUiMessage` payload
// isn't zod-validated the way a tool's `input` schema is) — `isColumn()` is
// the actual runtime gate, and an invalid value throws rather than being
// rejected at compile time.
export function addCard(
  board: Board,
  args: { column: string; title: string; description?: string }
): { board: Board; card: Card };
export function moveCard(
  board: Board,
  args: { id: string; to: string; toIndex?: number }
): { board: Board; card: Card };
export function updateCard(
  board: Board,
  args: { id: string; title?: string; description?: string }
): { board: Board; card: Card };
export function removeCard(board: Board, args: { id: string }): { board: Board };
