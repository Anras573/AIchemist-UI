/**
 * Canvas definition resolution — shared by the loopback MCP endpoint (#223,
 * which resolves a definition's `server.mjs`) and the `aichemist-canvas://` UI
 * protocol (#224, which resolves a definition's `ui/` folder).
 *
 * This is a minimal stand-in for the full discovery tiers (project → global →
 * built-in, with manifest validation) that #226 will add — it covers the
 * **global** directory (`~/.aichemist/canvases/`) and a small, hardcoded
 * **built-in** tier (canvases shipped with the app, under
 * `electron/canvas/builtin/`), so a canvas's host and UI can be resolved
 * end-to-end today without running or serving arbitrary repo-shipped code.
 * `resolveCanvasServerPath` deliberately never resolves the project tier
 * (`<projectPath>/.agents/canvases/`) — that tier is untrusted-by-default per
 * the design doc, and starting a host executes its `server.mjs`, so gating it
 * needs the project's trust state, which this module has no DB access to
 * check. `electron/canvas/trust.ts`'s `resolveTrustedCanvasServerPath` (#227)
 * is the trust-aware wrapper every host-starting caller uses instead; it
 * falls back to `resolveProjectDefinitionDir` below only once
 * `isProjectCanvasTrusted` holds for the definition's *current* on-disk
 * content. `resolveCanvasUiDir`, by contrast, DOES resolve the project tier
 * unconditionally (see its own docstring) — serving static UI files into the
 * sandboxed, networkless iframe needs no trust check.
 * Global-tier definitions are "the user put it there", and built-in
 * definitions are app code — both are trusted per the design doc's trust
 * model table. A name present in both tiers resolves to the global one (the
 * same "higher tier suppresses same-named lower" rule #226 generalized in
 * `discovery.ts`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { CanvasDefinition } from "../../src/types/index";

/** Test seam: override the global canvases directory (default `~/.aichemist/canvases`). Pass null to restore. */
let canvasesRootOverride: string | null = null;
export function _setCanvasesRootForTests(dir: string | null): void {
  canvasesRootOverride = dir;
}
export function canvasesRoot(): string {
  return canvasesRootOverride ?? nodePath.join(os.homedir(), ".aichemist", "canvases");
}

/**
 * The built-in tier's names, hardcoded rather than scanned — the full
 * discovery tiers (#226) will replace this with a real directory scan +
 * manifest validation, but until then this is the app's own registry of
 * what it ships. Adding a new built-in means adding its name here.
 */
const BUILTIN_DEFINITION_NAMES = ["kanban"] as const;

/**
 * Test seam: override the built-in canvases directory. Pass null to restore
 * the real one.
 */
let builtinCanvasesRootOverride: string | null = null;
export function _setBuiltinCanvasesRootForTests(dir: string | null): void {
  builtinCanvasesRootOverride = dir;
}

/**
 * Resolves to `<app root>/electron/canvas/builtin` — computed relative to
 * `__dirname` rather than `process.cwd()` so it's correct regardless of the
 * caller's working directory. This module is bundled into `dist/main/main.js`
 * (never into a separate lib entry), so at runtime `__dirname` is
 * `<app root>/dist/main` — two levels below the app root, the same depth
 * `electron/canvas` (this file's own source location) sits at, which is what
 * makes the *same* `../..` walk land on the app root whether this code is
 * running compiled (`dist/main`) or directly under vitest (`electron/canvas`,
 * ts-node/tsx style execution preserves the real source path). In a packaged
 * app, `electron/canvas/builtin/**` ships alongside `dist/main/**` (see
 * `electron-builder.yml`'s `files` list) at the same relative position inside
 * the asar, so this still resolves correctly.
 */
function computeBuiltinCanvasesRoot(): string {
  return nodePath.join(__dirname, "..", "..", "electron", "canvas", "builtin");
}

export function builtinCanvasesRoot(): string {
  return builtinCanvasesRootOverride ?? computeBuiltinCanvasesRoot();
}

/** A definition name may not contain path separators or traverse (`..`). */
export function isSafeDefinitionName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && name !== "." && !name.includes("..");
}

/**
 * Resolves `<root>/<definition>/<relative>`, rejecting an unsafe `definition`
 * outright and — defense in depth — any result that doesn't still resolve
 * inside `root`. Returns null rather than throwing so callers can treat "not
 * found" and "unsafe" identically.
 */
function resolveWithinRoot(root: string, definition: string, relative: string): string | null {
  if (!isSafeDefinitionName(definition)) return null;

  const candidate = nodePath.join(root, definition, relative);

  const resolvedBase = nodePath.resolve(root) + nodePath.sep;
  if (!nodePath.resolve(candidate).startsWith(resolvedBase)) return null;

  return candidate;
}

/**
 * Resolves `<relative>` for `definition` across tiers: the global directory
 * first (a user-provided definition — or override of a built-in name — is
 * trusted the same way), falling back to the built-in tier when `definition`
 * is a known built-in name. `check` distinguishes a file from a directory
 * lookup (`server.mjs` vs. `ui/`).
 */
function resolveAcrossTiers(
  definition: string,
  relative: string,
  check: (path: string) => boolean
): string | null {
  const globalCandidate = resolveWithinRoot(canvasesRoot(), definition, relative);
  if (globalCandidate && check(globalCandidate)) return globalCandidate;

  if ((BUILTIN_DEFINITION_NAMES as readonly string[]).includes(definition)) {
    const builtinCandidate = resolveWithinRoot(builtinCanvasesRoot(), definition, relative);
    if (builtinCandidate && check(builtinCandidate)) return builtinCandidate;
  }

  return null;
}

function isFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ─── Project tier ────────────────────────────────────────────────────────────

/** The project tier's root within a project: `<projectPath>/.agents/canvases`. */
export function projectCanvasesRoot(projectPath: string): string {
  return nodePath.join(projectPath, ".agents", "canvases");
}

/**
 * Resolves `<projectPath>/.agents/canvases/<definition>` — the project
 * tier's definition folder. Same untrusted-input handling as
 * {@link resolveCanvasServerPath} (rejects an unsafe `definition` and
 * defends against escaping the root), plus it must actually exist as a
 * directory. Deliberately does NOT check for a valid `canvas.json` inside —
 * callers that need "is this a real definition" (trust.ts's status/grant
 * paths) read and validate the manifest themselves; callers that only need
 * the folder to build a path (the UI preview fallback, the server-entry path
 * once trusted) don't need that extra read.
 */
export function resolveProjectDefinitionDir(projectPath: string, definition: string): string | null {
  const dir = resolveWithinRoot(projectCanvasesRoot(projectPath), definition, ".");
  return dir && isDirectory(dir) ? dir : null;
}

/**
 * Resolves a canvas definition's `server.mjs` path from disk. `definition` is
 * untrusted input (round-tripped from the `canvases` table, ultimately from
 * `CANVAS_CREATE`'s `definition` field) — rejected outright if it isn't a
 * plain name, so a value like `../../x` can't escape either tier's directory.
 * Returns null when no `server.mjs` is found; callers surface that as "canvas
 * unavailable" rather than throwing a discovery-shaped error that doesn't
 * exist yet.
 */
export function resolveCanvasServerPath(definition: string): string | null {
  return resolveAcrossTiers(definition, "server.mjs", isFile);
}

/**
 * Resolves a canvas definition's `ui/` folder — the root the
 * `aichemist-canvas://` protocol serves files from. Same untrusted-input
 * handling as {@link resolveCanvasServerPath}. Callers still apply their own
 * `realpath` + prefix check per requested file (a definition's `ui/` folder
 * can itself contain a symlink pointing outside it), this only resolves the
 * base directory.
 *
 * Checks global/built-in first (unconditionally trusted), then — when
 * `projectPath` is given — falls back to the project tier with **no trust
 * check**: unlike `resolveCanvasServerPath`/`resolveTrustedCanvasServerPath`,
 * this never executes anything. It only lets the protocol serve static files
 * into an already-sandboxed, networkless iframe (`sandbox="allow-scripts"`,
 * no `allow-same-origin`, `connect-src 'none'`), which is exactly the design
 * doc's "preview while untrusted" — the UI can render with the host stopped
 * (read-only, no tools) so the user can see what they're agreeing to run
 * before trusting it.
 */
export function resolveCanvasUiDir(definition: string, projectPath?: string): string | null {
  const tiered = resolveAcrossTiers(definition, "ui", isDirectory);
  if (tiered) return tiered;
  if (!projectPath) return null;
  const dir = resolveProjectDefinitionDir(projectPath, definition);
  if (!dir) return null;
  const uiDir = nodePath.join(dir, "ui");
  return isDirectory(uiDir) ? uiDir : null;
}

/**
 * Lists the built-in tier's definitions (metadata only, read from each one's
 * `canvas.json`) — used by the "New canvas…" picker so a built-in canvas
 * (currently just `kanban`) is offered before the full discovery tiers (#226)
 * land. A built-in whose manifest is missing or fails to parse is skipped
 * (logged) rather than breaking the listing for the rest — the same
 * fail-safe stance discovery will eventually apply per-definition.
 */
export function listBuiltinCanvasDefinitions(): CanvasDefinition[] {
  const root = builtinCanvasesRoot();
  const definitions: CanvasDefinition[] = [];
  for (const name of BUILTIN_DEFINITION_NAMES) {
    const manifestPath = nodePath.join(root, name, "canvas.json");
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      definitions.push(JSON.parse(raw) as CanvasDefinition);
    } catch (err) {
      console.error(`[canvas-definitions] failed to read built-in manifest "${name}":`, err);
    }
  }
  return definitions;
}
