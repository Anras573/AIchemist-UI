/**
 * Canvas definition resolution — shared by the loopback MCP endpoint (#223,
 * which resolves a definition's `server.mjs`) and the `aichemist-canvas://` UI
 * protocol (#224, which resolves a definition's `ui/` folder).
 *
 * This is a minimal stand-in for the full discovery tiers (project → global →
 * built-in, with manifest validation) that #226 will add — it covers only the
 * **global** directory (`~/.aichemist/canvases/`), so a canvas's host and UI
 * can be resolved end-to-end today without running or serving arbitrary
 * repo-shipped code. Deliberately does NOT resolve the project tier
 * (`<projectPath>/.agents/canvases/`) yet: that tier is untrusted-by-default
 * per the design doc and must not execute/serve before the trust prompt
 * (#227) exists to gate it. Global-tier definitions are "the user put it
 * there", so they're trusted per the design doc's trust model table.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

/** Test seam: override the global canvases directory (default `~/.aichemist/canvases`). Pass null to restore. */
let canvasesRootOverride: string | null = null;
export function _setCanvasesRootForTests(dir: string | null): void {
  canvasesRootOverride = dir;
}
export function canvasesRoot(): string {
  return canvasesRootOverride ?? nodePath.join(os.homedir(), ".aichemist", "canvases");
}

/** A definition name may not contain path separators or traverse (`..`). */
export function isSafeDefinitionName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && name !== "." && !name.includes("..");
}

/**
 * Resolves `<canvasesRoot>/<definition>/<relative>`, rejecting an unsafe
 * `definition` outright and — defense in depth — any result that doesn't
 * still resolve inside `canvasesRoot()`. Returns null rather than throwing so
 * callers can treat "not found" and "unsafe" identically.
 */
function resolveWithinCanvasesRoot(definition: string, relative: string): string | null {
  if (!isSafeDefinitionName(definition)) return null;

  const root = canvasesRoot();
  const candidate = nodePath.join(root, definition, relative);

  const resolvedBase = nodePath.resolve(root) + nodePath.sep;
  if (!nodePath.resolve(candidate).startsWith(resolvedBase)) return null;

  return candidate;
}

/**
 * Resolves a canvas definition's `server.mjs` path from disk. `definition` is
 * untrusted input (round-tripped from the `canvases` table, ultimately from
 * `CANVAS_CREATE`'s `definition` field) — rejected outright if it isn't a
 * plain name, so a value like `../../x` can't escape the canvases directory.
 * Returns null when no `server.mjs` is found; callers surface that as "canvas
 * unavailable" rather than throwing a discovery-shaped error that doesn't
 * exist yet.
 */
export function resolveCanvasServerPath(definition: string): string | null {
  const candidate = resolveWithinCanvasesRoot(definition, "server.mjs");
  if (!candidate) return null;
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch {
    // Not found.
  }
  return null;
}

/**
 * Resolves a canvas definition's `ui/` folder — the root the
 * `aichemist-canvas://` protocol serves files from. Same untrusted-input
 * handling as {@link resolveCanvasServerPath}. Callers still apply their own
 * `realpath` + prefix check per requested file (a definition's `ui/` folder
 * can itself contain a symlink pointing outside it), this only resolves the
 * base directory.
 */
export function resolveCanvasUiDir(definition: string): string | null {
  const candidate = resolveWithinCanvasesRoot(definition, "ui");
  if (!candidate) return null;
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    // Not found.
  }
  return null;
}
