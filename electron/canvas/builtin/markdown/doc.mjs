// Pure state-transform functions for the markdown canvas. State: `{ content: string }`.

export const MAX_CONTENT_LENGTH = 200_000;

export function createDoc() {
  return { content: "" };
}

function assertContent(content) {
  if (typeof content !== "string") throw new Error("content must be a string");
  if (content.length > MAX_CONTENT_LENGTH) throw new Error(`Document too large (max ${MAX_CONTENT_LENGTH} characters)`);
}

export function setContent(_doc, { content }) {
  assertContent(content);
  return { doc: { content } };
}

/** Appends on a new line (a blank line between blocks when the doc already has text). */
export function appendContent(doc, { content }) {
  assertContent(content);
  const separator = doc.content === "" ? "" : doc.content.endsWith("\n") ? "\n" : "\n\n";
  const next = doc.content + separator + content;
  assertContent(next);
  return { doc: { content: next } };
}
