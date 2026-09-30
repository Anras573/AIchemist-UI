// The checklist canvas's `CanvasServerDefinition`, factored out of
// `server.mjs` so tests can build it with real `zod` (see kanban's
// `definition.mjs` for the reasoning). One copy of the logic, shared by the
// shipped canvas and its tests.
import { addItem, clearCompleted, createList, removeItem, toggleItem, updateItem } from "./list.mjs";

/** @param {{ object: Function, string: Function, boolean: Function }} z a zod-shaped schema builder */
export function createChecklistDefinition(z) {
  return {
    initialState: createList(),

    tools: {
      get_list: {
        description: "Return the whole checklist.",
        input: z.object({}),
        approval: "none",
        handler: (_args, ctx) => ctx.state.get(),
      },
      add_item: {
        description: "Add an unchecked item to the end of the list.",
        input: z.object({ text: z.string().min(1) }),
        approval: "none",
        handler: (args, ctx) => {
          let item;
          ctx.state.update((list) => {
            const result = addItem(list, args);
            item = result.item;
            return result.list;
          });
          return { ok: true, item };
        },
      },
      set_done: {
        description: "Check or uncheck an item (flips it when `done` is omitted).",
        input: z.object({ id: z.string(), done: z.boolean().optional() }),
        approval: "none",
        handler: (args, ctx) => {
          ctx.state.update((list) => toggleItem(list, args).list);
          return { ok: true };
        },
      },
      update_item: {
        description: "Change an item's text.",
        input: z.object({ id: z.string(), text: z.string().min(1) }),
        approval: "ask",
        handler: (args, ctx) => {
          ctx.state.update((list) => updateItem(list, args).list);
          return { ok: true };
        },
      },
      remove_item: {
        description: "Remove an item from the list.",
        input: z.object({ id: z.string() }),
        approval: "ask",
        handler: (args, ctx) => {
          ctx.state.update((list) => removeItem(list, args).list);
          return { ok: true };
        },
      },
      clear_completed: {
        description: "Remove every checked item.",
        input: z.object({}),
        approval: "ask",
        handler: (_args, ctx) => {
          let removed = 0;
          ctx.state.update((list) => {
            const result = clearCompleted(list);
            removed = result.removed;
            return result.list;
          });
          return { ok: true, removed };
        },
      },
    },

    // Same reducers as the tools. Malformed UI messages are logged, never thrown.
    onUiMessage(message, ctx) {
      if (!message || typeof message !== "object") return;
      try {
        switch (message.type) {
          case "add":
            ctx.state.update((list) => addItem(list, message).list);
            break;
          case "toggle":
            ctx.state.update((list) => toggleItem(list, message).list);
            break;
          case "update":
            ctx.state.update((list) => updateItem(list, message).list);
            break;
          case "remove":
            ctx.state.update((list) => removeItem(list, message).list);
            break;
          case "clear_completed":
            ctx.state.update((list) => clearCompleted(list).list);
            break;
          default:
            break;
        }
      } catch (err) {
        ctx.log(`[checklist] failed to apply UI message: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
