// The built-in checklist canvas — the public server SDK, exactly as a
// user-authored canvas would use it. Logic lives in `definition.mjs` +
// `list.mjs`, shared with the tests.
import { defineCanvas, z } from "@aichemist/canvas";
import { createChecklistDefinition } from "./definition.mjs";

export default defineCanvas(createChecklistDefinition(z));
