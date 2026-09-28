// The kanban canvas's `CanvasServerDefinition`, factored out from `server.mjs`
// so it can be built with either the real `@aichemist/canvas` SDK (what
// `server.mjs` actually ships, dogfooding the same path a user-authored
// canvas would use) or a directly-imported `zod` in tests, which can't reach
// through the SDK's bare `@aichemist/canvas` specifier without a real canvas
// host process's ESM loader hook (see `../../host/loader-hook.ts`). Both
// call sites get the exact same tool/state logic — there's only one copy of
// it, here.
import { addCard, COLUMN_IDS, createBoard, moveCard, removeCard, updateCard } from "./board.mjs";

/**
 * @param {{ object: Function, enum: Function, string: Function, number: Function }} z a zod-shaped schema builder (the real `zod`, whichever module provides it)
 */
export function createKanbanDefinition(z) {
  const columnSchema = z.enum(COLUMN_IDS);

  return {
    initialState: createBoard(),

    tools: {
      get_board: {
        description: "Return the whole kanban board — every column and its cards.",
        input: z.object({}),
        approval: "none",
        handler: (_args, ctx) => ctx.state.get(),
      },

      add_card: {
        description: "Add a new card to a column.",
        input: z.object({
          column: columnSchema,
          title: z.string().min(1),
          description: z.string().optional(),
        }),
        approval: "none",
        handler: (args, ctx) => {
          let card;
          ctx.state.update((board) => {
            const result = addCard(board, args);
            card = result.card;
            return result.board;
          });
          return { ok: true, card };
        },
      },

      move_card: {
        description: "Move a card to another column (or reorder it within its column).",
        input: z.object({
          id: z.string(),
          to: columnSchema,
          toIndex: z.number().int().nonnegative().optional(),
        }),
        approval: "none",
        handler: (args, ctx) => {
          ctx.state.update((board) => moveCard(board, args).board);
          return { ok: true };
        },
      },

      update_card: {
        description: "Change a card's title and/or description.",
        input: z.object({
          id: z.string(),
          title: z.string().min(1).optional(),
          description: z.string().optional(),
        }),
        approval: "ask",
        handler: (args, ctx) => {
          let card;
          ctx.state.update((board) => {
            const result = updateCard(board, args);
            card = result.card;
            return result.board;
          });
          return { ok: true, card };
        },
      },

      remove_card: {
        description: "Remove a card from the board.",
        input: z.object({ id: z.string() }),
        approval: "ask",
        handler: (args, ctx) => {
          ctx.state.update((board) => removeCard(board, args).board);
          return { ok: true };
        },
      },
    },

    // UI edits go through the same reducers the tools use — one shared
    // implementation, never a second copy of "how a card moves". Defensive
    // try/catch per branch: a malformed UI message (e.g. a stale drag event
    // for a card the agent just removed) must not throw back through the
    // host's message loop, which has no error-reporting path to the UI for
    // `onUiMessage` and would otherwise crash the whole host process on an
    // uncaught rejection.
    onUiMessage(message, ctx) {
      if (!message || typeof message !== "object") return;
      try {
        switch (message.type) {
          case "add":
            ctx.state.update((board) => addCard(board, message).board);
            break;
          case "move":
            ctx.state.update((board) => moveCard(board, message).board);
            break;
          case "update":
            ctx.state.update((board) => updateCard(board, message).board);
            break;
          case "remove":
            ctx.state.update((board) => removeCard(board, message).board);
            break;
          default:
            break;
        }
      } catch (err) {
        ctx.log(`[kanban] failed to apply UI message: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
