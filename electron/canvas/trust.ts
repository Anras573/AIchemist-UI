/**
 * Trust model for project-tier canvas definitions (#227, part of #220) — the
 * third leg of the design doc's trust table. Built-in and global definitions
 * are trusted unconditionally (app code / the user put it there); a project
 * definition (`.agents/canvases/<name>/`, shipped with a cloned repo or
 * written by the agent through `write_file`) must never start a host or
 * expose tools until the user explicitly consents, and a later edit (e.g.
 * `git pull`, or the agent editing the canvas again) must re-prompt.
 *
 * Consent is bound to a content hash over the files that determine "what
 * code would run": the manifest, the server entry, and the dependency
 * manifest(s) — never the `ui/` folder, which doesn't execute (it's served
 * read-only into an already-sandboxed, networkless iframe regardless of
 * trust; see `resolveCanvasUiDir`'s preview fallback in `definitions.ts`).
 * The hash is persisted in `canvas_trust` (#221) keyed by
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

/** Always hashed when present. `server.mjs` is the only server path the runtime resolves (see `manifest.ts`), so this doesn't need to read the manifest first. */
const HASHED_ENTRY_FILENAMES = ["canvas.json", "server.mjs", "package.json"] as const;

/** At most one lockfile is hashed — whichever of these exists first. A project only ever has one active package manager's lockfile. */
const LOCKFILE_CANDIDATES = ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"] as const;

function filesToHash(defDir: string): string[] {
  const files: string[] = [...HASHED_ENTRY_FILENAMES];
  for (const name of LOCKFILE_CANDIDATES) {
    if (fs.existsSync(nodePath.join(defDir, name))) {
      files.push(name);
      break;
    }
  }
  return files;
}

/**
 * Hashes a definition folder's "what code would run" surface. Each
 * present-or-absent filename is folded into the digest alongside its content
 * (sorted, so hashing order never depends on filesystem iteration order) —
 * adding or removing one of these files (e.g. a `package.json` appearing
 * after `git pull`) changes the hash just as much as editing an existing
 * one's content does. A file that doesn't exist is skipped, not hashed as
 * empty, so "no package.json" and "empty package.json" hash differently.
 */
export function computeCanvasContentHash(defDir: string): string {
  const hash = crypto.createHash("sha256");
  for (const name of filesToHash(defDir).sort()) {
    let content: Buffer;
    try {
      content = fs.readFileSync(nodePath.join(defDir, name));
    } catch {
      continue;
    }
    hash.update(name);
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
  const trusted = record !== null && record.content_hash === contentHash;

  return {
    definition,
    path: dir,
    manifest: result.manifest,
    dependencies: readDependencyInfo(dir),
    contentHash,
    trusted,
    trustedAt: trusted ? record!.trusted_at : null,
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

/**
 * Runs `bun install` in a project definition's folder — only ever called
 * after trust is granted (the `CANVAS_TRUST_GRANT` handler calls this right
 * after `trustProjectCanvas` succeeds), never before. A no-op
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
      const message = `Failed to spawn "bun install": ${err instanceof Error ? err.message : String(err)}`;
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
    child.on("error", (err) => {
      const message = `Failed to run "bun install": ${err.message}`;
      output += (output ? "\n" : "") + message;
      opts?.onOutput?.(message);
      finish({ ok: false, output });
    });
    child.on("exit", (code) => {
      finish({ ok: code === 0, output });
    });
  });
}
