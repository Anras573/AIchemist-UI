// The built-in markdown canvas — public server SDK, same path a user canvas uses.
import { defineCanvas, z } from "@aichemist/canvas";
import { createMarkdownDefinition } from "./definition.mjs";

export default defineCanvas(createMarkdownDefinition(z));
