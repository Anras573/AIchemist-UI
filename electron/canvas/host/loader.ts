/**
 * Loads a canvas definition's `server.mjs` (#222). Split out from `entry.ts` so
 * it can be unit-tested with a real dynamic `import()` of a temp file, without
 * needing a `utilityProcess` to run it in.
 */
import { pathToFileURL } from "node:url";
import type { CanvasServerDefinition } from "./sdk";

function isCanvasServerDefinition(value: unknown): value is CanvasServerDefinition {
  return typeof value === "object" && value !== null;
}

/**
 * Dynamically imports `serverPath` and returns its default export. Throws a
 * plain `Error` (never returns undefined) on a missing file, a module that
 * doesn't default-export an object, or an error thrown while evaluating the
 * module — the caller (`entry.ts`) turns any of these into an `init.error`
 * message rather than letting the host crash on a bad definition.
 */
export async function loadServerModule(serverPath: string): Promise<CanvasServerDefinition> {
  const mod = (await import(pathToFileURL(serverPath).href)) as { default?: unknown };
  if (!isCanvasServerDefinition(mod.default)) {
    throw new Error(`Canvas server module has no default export from defineCanvas(): ${serverPath}`);
  }
  return mod.default;
}
