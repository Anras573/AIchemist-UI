// Ambient type declaration for definition.mjs (see board.d.mts for why).
import type { CanvasServerDefinition } from "../../host/sdk";

/** `z` is a zod-shaped schema builder — the real `z` from `@aichemist/canvas` (server.mjs) or from `zod` directly (tests). */
export function createKanbanDefinition(z: typeof import("zod").z): CanvasServerDefinition;
