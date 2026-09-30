// Ambient type declaration for definition.mjs (see ../kanban/board.d.mts for why).
import type { CanvasServerDefinition } from "../../host/sdk";

export function createChecklistDefinition(z: typeof import("zod").z): CanvasServerDefinition;
