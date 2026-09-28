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
 * `loader-hook.ts`'s `resolve` hook is where this gets enforced. Since round 3
 * of review (PR #238) switched that hook to `module.registerHooks()`, it's a
 * plain synchronous function and can be unit-tested directly too — but the
 * decision itself still lives here, pure and dependency-free, so it can be
 * tested without registering any hook at all (which has process-wide,
 * unregisterable side effects — see `loader-hook.ts`'s docstring).
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
 * Whether `candidate` is `root` itself or somewhere underneath it. Both sides
 * are run through `realpath` first, so a symlink can't launder an
 * otherwise-disallowed target into looking like it's inside the folder.
 * Exported as the general-purpose containment check — `isImportAllowed`
 * builds on it for the definition-folder-minus-`ui/` rule, and
 * `loader-hook.ts` uses it directly for the app's own trusted roots (the
 * canvas SDK build output, and the real `zod` package's own directory — see
 * that file's docstring on why those need their own allowance rather than
 * just the pinned entry-point files: a package's own internal relative
 * imports, e.g. `zod`'s `index.js` requiring its own `./v4/...` submodules,
 * resolve to paths under that package's directory, which is neither inside
 * the canvas's definition folder nor one of the two pinned specifiers
 * themselves).
 */
export function isPathWithin(candidate: string, root: string): boolean {
  const base = realpathOrSelf(nodePath.resolve(root));
  const target = realpathOrSelf(nodePath.resolve(candidate));
  return target === base || target.startsWith(base + nodePath.sep);
}

/**
 * Whether `resolvedPath` (an absolute file path some import resolved to) is
 * inside `definitionDir`'s allowed scope: anywhere in the definition folder
 * *except* its `ui/` subfolder — which covers the canvas's own
 * `node_modules` too, once installed, since that's just another subfolder of
 * the definition. Defense in depth: `trust.ts`'s grant flow already refuses a
 * definition containing any symlink outside `node_modules` up front, so a
 * symlink laundering an otherwise-disallowed target into this scope (caught
 * by `isPathWithin`'s `realpath` calls) should never actually trigger for a
 * canvas that passed that check, short of something changing on disk after
 * the host already started.
 */
export function isImportAllowed(resolvedPath: string, definitionDir: string): boolean {
  if (!isPathWithin(resolvedPath, definitionDir)) return false;
  return !isPathWithin(resolvedPath, nodePath.join(definitionDir, "ui"));
}
