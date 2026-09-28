/**
 * Trust model for project-tier canvas definitions (#227, part of #220) — the
 * third leg of the design doc's trust table. Built-in and global definitions
 * are trusted unconditionally (app code / the user put it there); a project
 * definition (`.agents/canvases/<name>/`, shipped with a cloned repo or
 * written by the agent through `write_file`) must never start a host or
 * expose tools until the user explicitly consents, and a later edit (e.g.
 * `git pull`, or the agent editing the canvas again) must re-prompt.
 *
 * Consent is bound to a content hash over the **entire** definition folder —
 * not just `canvas.json`/`server.mjs`/`package.json` — because `server.mjs`
 * routinely imports sibling modules (the built-in kanban itself splits into
 * `server.mjs` + `definition.mjs` + `board.mjs`), and any of those files is
 * just as much "code that would run" as `server.mjs` itself (#227 review on
 * PR #238: a hash limited to the top-level trio let an imported module change
 * with no re-prompt). Excluded: the `ui/` folder at the definition's root,
 * which never executes — it's served read-only into an already-sandboxed,
 * networkless iframe regardless of trust (see `resolveCanvasUiDir`'s preview
 * fallback in `definitions.ts`) — and any `node_modules` directory at any
 * depth, which is dependency-managed content, not authored code (see
 * `computeCanvasContentHash`'s docstring for how a *pre-existing* one is
 * handled instead). The hash is persisted in `canvas_trust` (#221) keyed by
 * `(project_id, definition)` via `setCanvasTrust`/`getCanvasTrust`/
 * `deleteCanvasTrust` (`store.ts`) — this module owns hashing, the
 * grant/revoke/status operations built on top of that storage, dependency
 * installation, and the trust-gated resolver every host-starting caller uses
 * instead of `definitions.ts`'s bare `resolveCanvasServerPath`.
 */
import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  Canvas,
  CanvasDependencyInfo,
  CanvasInstallResult,
  CanvasTrust,
  CanvasTrustStatus,
} from "../../src/types/index";
import { resolveCanvasServerPath, resolveProjectDefinitionDir } from "./definitions";
import { parseCanvasManifest } from "./manifest";
import { deleteCanvasTrust, getCanvasTrust, setCanvasTrust } from "./store";

// ─── Hashing ─────────────────────────────────────────────────────────────────

/**
 * Directory names excluded from the recursive walk. `ui/` only at the
 * definition's root (a coincidentally-named `lib/ui/` deeper in authored code
 * is real code and stays hashed); `node_modules` at *any* depth (bun/npm can
 * nest it), since it's dependency-managed content rather than authored code —
 * see this function's docstring for how a pre-existing one is handled.
 */
function isExcludedDir(name: string, isRoot: boolean): boolean {
  if (name === "node_modules") return true;
  if (isRoot && name === "ui") return true;
  return false;
}

export interface DefinitionScan {
  /** Every regular file under `defDir` in the hashed scope (relative, POSIX-style paths, sorted). */
  files: string[];
  /**
   * Any symlink (file or directory) found in the hashed scope (relative
   * paths, sorted) — never followed, since a `Dirent`'s `isFile()`/
   * `isDirectory()` are both false for one. Previously that just meant a
   * symlinked module silently dropped out of the hash (#227 review on PR
   * #238: a symlinked `server.mjs`, or a module it imports through a
   * symlink, could change after approval with no re-prompt at all, since it
   * was never in the hashed set to begin with). Now surfaced so callers
   * (`getProjectCanvasTrustStatus`, `CANVAS_TRUST_GRANT`) can refuse a
   * definition containing one outright, the same way they already refuse a
   * pre-existing `node_modules` — rather than silently hashing around it.
   */
  symlinks: string[];
}

/**
 * Recursively scans `defDir`, skipping excluded directories (`isExcludedDir`)
 * and never following a symlink (collected separately instead — see
 * `DefinitionScan.symlinks`). Fail-open per file/dir (an unreadable subtree
 * is skipped, not thrown) — same stance as `discoverCanvasDefinitions`.
 */
function scanDefinition(defDir: string): DefinitionScan {
  const files: string[] = [];
  const symlinks: string[] = [];
  function walk(relDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(nodePath.join(defDir, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const excluded = isExcludedDir(entry.name, relDir === "");
      if (entry.isSymbolicLink()) {
        if (!excluded) symlinks.push(relPath);
        continue;
      }
      if (entry.isDirectory()) {
        if (excluded) continue;
        walk(relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }
  walk("");
  files.sort();
  symlinks.sort();
  return { files, symlinks };
}

/**
 * Whether any symlink sits in a project definition's hashed scope (outside
 * `node_modules`, which is never hashed or walked in the first place). Used
 * to refuse trust outright rather than silently hash around it — see
 * `DefinitionScan.symlinks`'s docstring.
 */
export function hasSymlinksInDefinition(defDir: string): boolean {
  return scanDefinition(defDir).symlinks.length > 0;
}

/**
 * Hashes a definition folder's "what code would run" surface: every file
 * under it except `ui/` (root only) and `node_modules` (any depth) — see the
 * module docstring for why. Each file's relative path is folded into the
 * digest alongside its content (sorted, so hashing order never depends on
 * filesystem iteration order) — a file appearing/disappearing (e.g. a
 * `package.json` added by a `git pull`, or a new imported module) changes the
 * hash just as much as editing an existing one's content does.
 *
 * **`node_modules` is deliberately never hashed**, at any depth: hashing a
 * whole dependency tree on every trust check (this runs on effectively every
 * canvas-bearing turn via `resolveTrustedCanvasServerPath`) would be slow and
 * would churn on routine `bun install` output, and it's *dependency*-managed
 * content the lockfile already pins, not authored code. That leaves a real
 * gap the #227 review flagged: a `node_modules` folder *committed to the
 * repo* would let a bare import (`import "some-pkg"`) resolve to
 * attacker-controlled code that this hash can never see. The gap is closed
 * one layer up, not here: `CANVAS_TRUST_GRANT`'s handler refuses to grant
 * trust at all while a `node_modules` already exists in the definition folder
 * *before* AIchemist's own `bun install` runs — see that handler's comment.
 */
export function computeCanvasContentHash(defDir: string): string {
  const hash = crypto.createHash("sha256");
  for (const relPath of scanDefinition(defDir).files) {
    let content: Buffer;
    try {
      content = fs.readFileSync(nodePath.join(defDir, relPath));
    } catch {
      continue; // removed between listing and reading — treat as absent
    }
    hash.update(relPath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

// ─── Status ──────────────────────────────────────────────────────────────────

function readDependencyInfo(defDir: string): CanvasDependencyInfo {
  let raw: string;
  try {
    raw = fs.readFileSync(nodePath.join(defDir, "package.json"), "utf8");
  } catch {
    return { names: [], hasPackageJson: false };
  }
  try {
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].sort();
    return { names, hasPackageJson: true };
  } catch {
    // Exists but doesn't parse — still "has one" so the prompt shows an
    // install is coming, and `bun install` itself will surface the real
    // parse error rather than this silently pretending there's nothing to do.
    return { names: [], hasPackageJson: true };
  }
}

/**
 * Reads a project-tier definition's trust status: its manifest, declared
 * dependencies, current content hash, and whether a stored `canvas_trust`
 * record's hash still matches it. Null when the folder isn't a valid project
 * definition — missing, an unsafe name, or a `canvas.json` that fails to read
 * or validate — mirroring `resolveProjectDefinitionDir`'s own "not found"
 * contract rather than throwing.
 */
export function getProjectCanvasTrustStatus(
  db: Database,
  projectId: string,
  projectPath: string,
  definition: string
): CanvasTrustStatus | null {
  const dir = resolveProjectDefinitionDir(projectPath, definition);
  if (!dir) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(nodePath.join(dir, "canvas.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = parseCanvasManifest(parsed);
  if (!result.success) return null;

  const contentHash = computeCanvasContentHash(dir);
  const record = getCanvasTrust(db, projectId, definition);
  // A symlink in the hashed scope means the hash can't actually stand for
  // "what code would run" (#227 review) — never report this one as trusted,
  // whatever a stale record says, and surface why so the prompt can explain
  // it instead of just refusing a "Trust and run" click with no context.
  const blockedReason = hasSymlinksInDefinition(dir)
    ? "This canvas contains a symlink, which isn't supported — AIchemist can't verify what code a symlink actually points to. Remove it (or replace it with a real file/folder) to trust this canvas."
    : null;
  const trusted = blockedReason === null && record !== null && record.content_hash === contentHash;

  return {
    definition,
    path: dir,
    manifest: result.manifest,
    dependencies: readDependencyInfo(dir),
    contentHash,
    trusted,
    trustedAt: trusted ? record!.trusted_at : null,
    blockedReason,
  };
}

/**
 * Cheap trust check used by the resolvers below — recomputes the content
 * hash and compares it to the stored record, without re-reading or
 * validating the manifest (unlike `getProjectCanvasTrustStatus`, which the
 * trust prompt needs the manifest for anyway). False for anything that isn't
 * a currently-trusted, unmodified project definition.
 */
export function isProjectCanvasTrusted(
  db: Database,
  projectId: string,
  projectPath: string,
  definition: string
): boolean {
  const record = getCanvasTrust(db, projectId, definition);
  if (!record) return false;
  const dir = resolveProjectDefinitionDir(projectPath, definition);
  if (!dir) return false;
  return record.content_hash === computeCanvasContentHash(dir);
}

// ─── Grant / revoke ──────────────────────────────────────────────────────────

export class CanvasTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasTrustError";
  }
}

/**
 * Records consent to run a project definition's server code, bound to its
 * *current* on-disk content hash. Throws `CanvasTrustError` if `definition`
 * doesn't resolve to a real project-tier folder — the caller (the
 * `CANVAS_TRUST_GRANT` handler) is expected to have already shown the user
 * the manifest via `getProjectCanvasTrustStatus`, so this should only fail if
 * the folder was removed between that read and the grant.
 */
export function trustProjectCanvas(
  db: Database,
  projectId: string,
  projectPath: string,
  definition: string
): CanvasTrust {
  const dir = resolveProjectDefinitionDir(projectPath, definition);
  if (!dir) throw new CanvasTrustError(`Project canvas definition not found: ${definition}`);
  return setCanvasTrust(db, projectId, definition, computeCanvasContentHash(dir));
}

/** Revokes a project definition's trust record. A no-op if it was never trusted. */
export function revokeProjectCanvasTrust(db: Database, projectId: string, definition: string): void {
  deleteCanvasTrust(db, projectId, definition);
}

// ─── Trust-gated resolution ──────────────────────────────────────────────────

/**
 * Resolves a canvas instance's `server.mjs` for STARTING a host, honoring
 * trust: global/built-in resolve unconditionally via the plain
 * `resolveCanvasServerPath` (trusted per the design doc's tier table); a
 * project-tier definition only resolves once `isProjectCanvasTrusted` holds
 * for its *current* on-disk content.
 *
 * An untrusted or edited-since-trust project canvas resolves to null here —
 * the same "unavailable" signal `resolveCanvasServerPath` already returns for
 * a missing definition — so every existing host-starting caller
 * (`CanvasHostManager.start` via the `CANVAS_OPEN`/`CANVAS_RESTART` handlers,
 * the MCP endpoint's `ensureHostRunning`) refuses it for free, with no gating
 * logic of its own to get wrong or forget.
 */
export function resolveTrustedCanvasServerPath(
  db: Database,
  canvas: Pick<Canvas, "project_id" | "definition">,
  projectPath: string
): string | null {
  const tiered = resolveCanvasServerPath(canvas.definition);
  if (tiered) return tiered;
  if (!isProjectCanvasTrusted(db, canvas.project_id, projectPath, canvas.definition)) return null;
  const dir = resolveProjectDefinitionDir(projectPath, canvas.definition);
  return dir ? nodePath.join(dir, "server.mjs") : null;
}

// ─── Dependency install ──────────────────────────────────────────────────────

export type CanvasInstallSpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string }
) => ChildProcess;

const defaultInstallSpawn: CanvasInstallSpawnFn = (command, args, options) =>
  spawnChildProcess(command, args, { cwd: options.cwd, shell: process.platform === "win32" });

let installSpawnOverride: CanvasInstallSpawnFn | null = null;
/** Test seam: inject a fake `spawn` for `installCanvasDependencies` instead of running a real `bun install`. Pass null to restore. */
export function _setCanvasInstallSpawnForTests(fn: CanvasInstallSpawnFn | null): void {
  installSpawnOverride = fn;
}

/** A missing `bun` binary surfaces from `spawn` as an `ENOENT`-coded error — translate that into copy that tells the user what to do instead of a raw OS error. */
function describeInstallError(err: NodeJS.ErrnoException, verb: "spawn" | "run"): string {
  if (err.code === "ENOENT") {
    return '"bun" is required to install this canvas\'s dependencies, but it could not be found on PATH.';
  }
  return `Failed to ${verb} "bun install": ${err.message}`;
}

/**
 * Runs `bun install` in a project definition's folder — only ever called
 * after the `CANVAS_TRUST_GRANT` handler's pre-install checks pass (the
 * content-hash match and the "no pre-existing `node_modules`" check), and
 * *before* it records trust (see that handler's comment on why install comes
 * first: hashing after install means the lockfile `bun install` may create
 * doesn't immediately invalidate the trust the user just granted). A no-op
 * (`{ ok: true, output: "" }`) when the folder declares no `package.json` —
 * most canvases, the built-in kanban included, have no dependencies at all.
 * `onOutput` streams stdout/stderr chunks as they arrive (for a live install
 * log in the trust prompt); the resolved `output` is always the full combined
 * transcript regardless of whether a listener was given.
 */
export function installCanvasDependencies(
  defDir: string,
  opts?: { onOutput?: (chunk: string) => void }
): Promise<CanvasInstallResult> {
  if (!fs.existsSync(nodePath.join(defDir, "package.json"))) {
    return Promise.resolve({ ok: true, output: "" });
  }

  return new Promise((resolve) => {
    const spawnFn = installSpawnOverride ?? defaultInstallSpawn;
    let output = "";
    let settled = false;
    const finish = (result: CanvasInstallResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawnFn("bun", ["install"], { cwd: defDir });
    } catch (err) {
      const message = describeInstallError(err as NodeJS.ErrnoException, "spawn");
      finish({ ok: false, output: message });
      return;
    }

    const onChunk = (chunk: Buffer | string) => {
      const text = chunk.toString();
      output += text;
      opts?.onOutput?.(text);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err: NodeJS.ErrnoException) => {
      const message = describeInstallError(err, "run");
      output += (output ? "\n" : "") + message;
      opts?.onOutput?.(message);
      finish({ ok: false, output });
    });
    child.on("exit", (code) => {
      finish({ ok: code === 0, output });
    });
  });
}
