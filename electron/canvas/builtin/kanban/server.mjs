// The built-in kanban canvas (#225) — a full worked example of the public
// canvas server SDK: `defineCanvas` + `z` resolved with no install step by
// the host's ESM loader hook (see `../../host/loader-hook.ts`), exactly the
// way a user-authored `server.mjs` under `~/.aichemist/canvases/` would
// import them. The actual tool/state logic lives in `definition.mjs` +
// `board.mjs`, shared with this module's tests.
import { defineCanvas, z } from "@aichemist/canvas";
import { createKanbanDefinition } from "./definition.mjs";

export default defineCanvas(createKanbanDefinition(z));
