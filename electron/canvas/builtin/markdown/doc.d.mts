// Ambient type declaration for doc.mjs (see ../kanban/board.d.mts for why).
export interface MarkdownDoc {
  content: string;
}
export const MAX_CONTENT_LENGTH: number;
export function createDoc(): MarkdownDoc;
export function setContent(doc: MarkdownDoc, args: { content: string }): { doc: MarkdownDoc };
export function appendContent(doc: MarkdownDoc, args: { content: string }): { doc: MarkdownDoc };
