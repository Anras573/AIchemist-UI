// The markdown canvas's `CanvasServerDefinition` (see kanban's `definition.mjs`
// for why it's split from `server.mjs`).
import { appendContent, createDoc, setContent } from "./doc.mjs";

/** @param {{ object: Function, string: Function }} z a zod-shaped schema builder */
export function createMarkdownDefinition(z) {
  return {
    initialState: createDoc(),

    tools: {
      get_document: {
        description: "Return the document's current markdown.",
        input: z.object({}),
        approval: "none",
        handler: (_args, ctx) => ctx.state.get(),
      },
      append: {
        description: "Append markdown to the end of the document.",
        input: z.object({ content: z.string().min(1) }),
        approval: "none",
        handler: (args, ctx) => {
          ctx.state.update((doc) => appendContent(doc, args).doc);
          return { ok: true };
        },
      },
      set_document: {
        description: "Replace the entire document (overwrites the user's text).",
        input: z.object({ content: z.string() }),
        approval: "ask",
        handler: (args, ctx) => {
          ctx.state.update((doc) => setContent(doc, args).doc);
          return { ok: true };
        },
      },
    },

    onUiMessage(message, ctx) {
      if (!message || typeof message !== "object") return;
      try {
        if (message.type === "set") ctx.state.update((doc) => setContent(doc, message).doc);
      } catch (err) {
        ctx.log(`[markdown] failed to apply UI message: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
