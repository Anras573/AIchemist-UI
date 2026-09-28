/**
 * Confines what a canvas server module is allowed to import to the same
 * scope its content hash covers (#227 review on PR #238, second round).
 *
 * Without this, `resolveTrustedCanvasServerPath`'s hash and the code the host
 * process can actually execute are two different sets: `server.mjs` can
 * `import` a module under the definition's own `ui/` folder (excluded from
 * the hash — it's served read-only into the sandboxed iframe, never meant to
 * run in the host) or a bare specifier that Node's normal upward
 * `node_modules` search resolves to a package installed for the *app itself*
 * (outside the definition folder entirely, since a project-tier canvas has
 * no dependencies of its own until `bun install` runs). Either way, editing
 * that file changes what the canvas does with no re-prompt, because it was
 * never part of what got hashed and approved.
 *
 * `loader-hook.ts`'s `resolve` hook is where this gets enforced, but that
 * hook only runs inside a real ESM loader thread (see its own docstring for
 * why it isn't unit-tested) — so the actual decision lives here instead,
 * pure and synchronous, where it can be tested directly.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";

/** Resolves symlinks/`..` segments; falls back to the plain resolved path for something that doesn't exist (yet) rather than throwing. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Whether `resolvedPath` (an absolute file path some import resolved to) is
 * inside `definitionDir`'s allowed scope: anywhere in the definition folder
 * *except* its `ui/` subfolder — which covers the canvas's own
 * `node_modules` too, once installed, since that's just another subfolder of
 * the definition. Both sides are run through `realpath` first, so a symlink
 * can't launder an otherwise-disallowed target into looking like it's inside
 * the folder — defense in depth: `trust.ts`'s grant flow already refuses a
 * definition containing any symlink outside `node_modules` up front, so this
 * should never actually trigger for a canvas that passed that check, short
 * of something changing on disk after the host already started.
 */
export function isImportAllowed(resolvedPath: string, definitionDir: string): boolean {
  const base = realpathOrSelf(nodePath.resolve(definitionDir));
  const target = realpathOrSelf(nodePath.resolve(resolvedPath));

  if (target !== base && !target.startsWith(base + nodePath.sep)) return false;

  const uiDir = nodePath.join(base, "ui");
  return target !== uiDir && !target.startsWith(uiDir + nodePath.sep);
}
