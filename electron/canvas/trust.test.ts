// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { migrate } from "../db";
import { addProject } from "../projects";
import { createCanvas } from "./store";
import { _setBuiltinCanvasesRootForTests, _setCanvasesRootForTests } from "./definitions";
import {
  CanvasTrustError,
  _setCanvasInstallSpawnForTests,
  computeCanvasContentHash,
  computeCanvasDepsHash,
  getProjectCanvasTrustStatus,
  hasSymlinksInDefinition,
  installCanvasDependencies,
  isProjectCanvasTrusted,
  resolveTrustedCanvasServerPath,
  revokeProjectCanvasTrust,
  trustProjectCanvas,
} from "./trust";

let db: Database.Database;
let projectPath: string;
let projectId: string;

function writeDefinition(
  root: string,
  name: string,
  opts?: { server?: string; extraFiles?: Record<string, string> }
): string {
  const dir = nodePath.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    nodePath.join(dir, "canvas.json"),
    JSON.stringify({ name, description: "desc", version: 1, server: "server.mjs", ui: "ui/index.html" })
  );
  fs.writeFileSync(nodePath.join(dir, "server.mjs"), opts?.server ?? "export default {};");
  for (const [fileName, content] of Object.entries(opts?.extraFiles ?? {})) {
    fs.writeFileSync(nodePath.join(dir, fileName), content);
  }
  return dir;
}

function projectDefDir(name: string): string {
  return nodePath.join(projectPath, ".agents", "canvases", name);
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  projectPath = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-trust-"));
  const project = addProject(db, projectPath);
  projectId = project.id;
  _setCanvasInstallSpawnForTests(null);
});

afterEach(() => {
  db.close();
  fs.rmSync(projectPath, { recursive: true, force: true });
  _setCanvasesRootForTests(null);
  _setBuiltinCanvasesRootForTests(null);
  _setCanvasInstallSpawnForTests(null);
});

// ─── Hashing ─────────────────────────────────────────────────────────────────

describe("computeCanvasContentHash", () => {
  it("is stable for identical content", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    expect(computeCanvasContentHash(dir)).toBe(computeCanvasContentHash(dir));
  });

  it("changes when server.mjs is edited", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const before = computeCanvasContentHash(dir);
    fs.writeFileSync(nodePath.join(dir, "server.mjs"), "export default { edited: true };");
    expect(computeCanvasContentHash(dir)).not.toBe(before);
  });

  it("changes when canvas.json is edited", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const before = computeCanvasContentHash(dir);
    fs.writeFileSync(
      nodePath.join(dir, "canvas.json"),
      JSON.stringify({ name: "widgets", description: "changed", version: 1, server: "server.mjs", ui: "ui/index.html" })
    );
    expect(computeCanvasContentHash(dir)).not.toBe(before);
  });

  it("changes when a package.json appears", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const before = computeCanvasContentHash(dir);
    fs.writeFileSync(nodePath.join(dir, "package.json"), JSON.stringify({ dependencies: { zod: "^3" } }));
    expect(computeCanvasContentHash(dir)).not.toBe(before);
  });

  it("changes when a lockfile appears alongside an unchanged package.json", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets", {
      extraFiles: { "package.json": JSON.stringify({}) },
    });
    const before = computeCanvasContentHash(dir);
    fs.writeFileSync(nodePath.join(dir, "bun.lock"), "# lockfile v1\n");
    expect(computeCanvasContentHash(dir)).not.toBe(before);
  });

  it("is unaffected by ui/ folder contents", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const before = computeCanvasContentHash(dir);
    fs.mkdirSync(nodePath.join(dir, "ui"), { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "ui", "index.html"), "<html></html>");
    expect(computeCanvasContentHash(dir)).toBe(before);
  });

  // #227 review on PR #238: the original hash only covered canvas.json/
  // server.mjs/package.json, so editing a module server.mjs imports (the
  // normal shape — the built-in kanban itself splits into server.mjs +
  // definition.mjs + board.mjs) never re-prompted. These prove the fix.

  it("changes when a module server.mjs imports is edited, at any depth", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    fs.writeFileSync(nodePath.join(dir, "lib.mjs"), "export const x = 1;");
    fs.mkdirSync(nodePath.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "tools", "helper.mjs"), "export const y = 1;");
    const before = computeCanvasContentHash(dir);

    fs.writeFileSync(nodePath.join(dir, "lib.mjs"), "export const x = 2;");
    expect(computeCanvasContentHash(dir)).not.toBe(before);

    const afterLib = computeCanvasContentHash(dir);
    fs.writeFileSync(nodePath.join(dir, "tools", "helper.mjs"), "export const y = 2;");
    expect(computeCanvasContentHash(dir)).not.toBe(afterLib);
  });

  it("changes when a new file is added anywhere outside ui/", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const before = computeCanvasContentHash(dir);
    fs.writeFileSync(nodePath.join(dir, "new-module.mjs"), "export default {};");
    expect(computeCanvasContentHash(dir)).not.toBe(before);
  });

  it("only excludes ui/ at the definition root, not a coincidentally-named nested folder", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    fs.mkdirSync(nodePath.join(dir, "lib", "ui"), { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "lib", "ui", "widget.mjs"), "export default 1;");
    const before = computeCanvasContentHash(dir);
    fs.writeFileSync(nodePath.join(dir, "lib", "ui", "widget.mjs"), "export default 2;");
    expect(computeCanvasContentHash(dir)).not.toBe(before);
  });

  it("never hashes node_modules, at any depth", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets", {
      extraFiles: { "package.json": JSON.stringify({ dependencies: { "is-number": "^7" } }) },
    });
    const before = computeCanvasContentHash(dir);

    fs.mkdirSync(nodePath.join(dir, "node_modules", "is-number"), { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "node_modules", "is-number", "index.js"), "module.exports = () => true;");
    // Adding node_modules itself doesn't change the hash...
    expect(computeCanvasContentHash(dir)).toBe(before);

    // ...and neither does editing a file inside it (the #227 review's
    // "committed node_modules" scenario — closed instead by CANVAS_TRUST_GRANT
    // refusing to grant while one pre-exists, not by hashing it).
    fs.writeFileSync(nodePath.join(dir, "node_modules", "is-number", "index.js"), "module.exports = () => false;");
    expect(computeCanvasContentHash(dir)).toBe(before);
  });

  // #227 review (round 2): a symlinked module (or server.mjs itself) is
  // never followed by the walk, so it silently dropped out of the hash
  // entirely — editing its target changed nothing. These document that the
  // hash itself stays blind to it (expected — a symlink is never followed);
  // `hasSymlinksInDefinition` (below) is what actually catches this.
  it("is unaffected by a symlink's target changing, since the walk never follows it", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    // The target lives OUTSIDE the definition folder entirely (the actual
    // #227 review scenario: a symlink to `<project>/shared.mjs`) — a target
    // inside the folder would just get hashed directly as its own real file,
    // which isn't the gap being demonstrated here.
    const outside = fs.mkdtempSync(nodePath.join(os.tmpdir(), "trust-symlink-target-"));
    const realFile = nodePath.join(outside, "shared.mjs");
    fs.writeFileSync(realFile, "export const x = 1;");
    fs.symlinkSync(realFile, nodePath.join(dir, "lib.mjs"));
    try {
      const before = computeCanvasContentHash(dir);
      fs.writeFileSync(realFile, "export const x = 2;");
      expect(computeCanvasContentHash(dir)).toBe(before);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// #227 review round 3: computeCanvasContentHash deliberately never hashes
// node_modules (see its docstring), which left nothing re-verifying that
// folder's contents after bun install populated it. computeCanvasDepsHash
// closes that gap; these prove it independently of the trust-record
// integration tests below.
describe("computeCanvasDepsHash", () => {
  it("is null when there is no node_modules at all", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    expect(computeCanvasDepsHash(dir)).toBeNull();
  });

  it("is null when node_modules exists but is empty", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    fs.mkdirSync(nodePath.join(dir, "node_modules"), { recursive: true });
    expect(computeCanvasDepsHash(dir)).toBeNull();
  });

  it("is stable for identical content", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    fs.mkdirSync(nodePath.join(dir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = {};");
    expect(computeCanvasDepsHash(dir)).toBe(computeCanvasDepsHash(dir));
  });

  it("changes when a file inside node_modules is edited", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const pkgFile = nodePath.join(dir, "node_modules", "left-pad", "index.js");
    fs.mkdirSync(nodePath.dirname(pkgFile), { recursive: true });
    fs.writeFileSync(pkgFile, "module.exports = {};");
    const before = computeCanvasDepsHash(dir);

    fs.writeFileSync(pkgFile, "module.exports = { edited: true };");
    expect(computeCanvasDepsHash(dir)).not.toBe(before);
  });

  it("changes when a file is added to node_modules", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    fs.mkdirSync(nodePath.join(dir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = {};");
    const before = computeCanvasDepsHash(dir);

    fs.writeFileSync(nodePath.join(dir, "node_modules", "left-pad", "package.json"), JSON.stringify({}));
    expect(computeCanvasDepsHash(dir)).not.toBe(before);
  });

  it("is unaffected by content_hash's own hashed scope (server.mjs, canvas.json)", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    fs.mkdirSync(nodePath.join(dir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = {};");
    const before = computeCanvasDepsHash(dir);

    fs.writeFileSync(nodePath.join(dir, "server.mjs"), "export default { edited: true };");
    expect(computeCanvasDepsHash(dir)).toBe(before);
  });
});

describe("hasSymlinksInDefinition", () => {
  it("is false for a definition with no symlinks", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    expect(hasSymlinksInDefinition(dir)).toBe(false);
  });

  it("is true for a symlinked module server.mjs imports", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    fs.writeFileSync(nodePath.join(dir, "real.mjs"), "export const x = 1;");
    fs.symlinkSync(nodePath.join(dir, "real.mjs"), nodePath.join(dir, "lib.mjs"));
    expect(hasSymlinksInDefinition(dir)).toBe(true);
  });

  it("is true when server.mjs itself is a symlink", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const realServer = nodePath.join(dir, "real-server.mjs");
    fs.writeFileSync(realServer, "export default {};");
    fs.rmSync(nodePath.join(dir, "server.mjs"));
    fs.symlinkSync(realServer, nodePath.join(dir, "server.mjs"));
    expect(hasSymlinksInDefinition(dir)).toBe(true);
  });

  it("ignores a symlink inside node_modules (excluded from the scan entirely)", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    fs.mkdirSync(nodePath.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "real-dep.js"), "module.exports = {};");
    fs.symlinkSync(nodePath.join(dir, "real-dep.js"), nodePath.join(dir, "node_modules", "dep.js"));
    expect(hasSymlinksInDefinition(dir)).toBe(false);
  });

  it("ignores a symlink at the root literally named ui or node_modules", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const realUi = fs.mkdtempSync(nodePath.join(os.tmpdir(), "real-ui-"));
    fs.symlinkSync(realUi, nodePath.join(dir, "ui"));
    expect(hasSymlinksInDefinition(dir)).toBe(false);
    fs.rmSync(realUi, { recursive: true, force: true });
  });

  it("does not descend into a symlinked directory even if it isn't excluded by name", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const realLib = fs.mkdtempSync(nodePath.join(os.tmpdir(), "real-lib-"));
    fs.writeFileSync(nodePath.join(realLib, "x.mjs"), "export default 1;");
    fs.symlinkSync(realLib, nodePath.join(dir, "lib"));
    expect(hasSymlinksInDefinition(dir)).toBe(true);
    fs.rmSync(realLib, { recursive: true, force: true });
  });
});

// ─── Status ──────────────────────────────────────────────────────────────────

describe("getProjectCanvasTrustStatus", () => {
  it("reports untrusted with dependency info for a never-granted definition", () => {
    writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets", {
      extraFiles: { "package.json": JSON.stringify({ dependencies: { zod: "^3" }, devDependencies: { vitest: "^2" } }) },
    });
    const status = getProjectCanvasTrustStatus(db, projectId, projectPath, "widgets");
    expect(status).not.toBeNull();
    expect(status?.trusted).toBe(false);
    expect(status?.trustedAt).toBeNull();
    expect(status?.dependencies).toEqual({ names: ["vitest", "zod"], hasPackageJson: true });
    expect(status?.manifest.name).toBe("widgets");
    expect(status?.blockedReason).toBeNull();
  });

  it("reports blockedReason (and never trusted) when the definition contains a symlink, even if a stale trust record's hash matches", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    // Trust first, while there's no symlink yet — the stored hash is the
    // "clean" one, and computeCanvasContentHash never sees the symlink
    // that's about to appear (it's never followed), so the hash alone
    // wouldn't catch this.
    trustProjectCanvas(db, projectId, projectPath, "widgets");
    fs.writeFileSync(nodePath.join(dir, "real.mjs"), "export const x = 1;");
    fs.symlinkSync(nodePath.join(dir, "real.mjs"), nodePath.join(dir, "lib.mjs"));

    const status = getProjectCanvasTrustStatus(db, projectId, projectPath, "widgets");
    expect(status?.trusted).toBe(false);
    expect(status?.trustedAt).toBeNull();
    expect(status?.blockedReason).toMatch(/symlink/i);
  });

  it("returns null for a definition that doesn't exist", () => {
    expect(getProjectCanvasTrustStatus(db, projectId, projectPath, "does-not-exist")).toBeNull();
  });

  it("returns null when canvas.json fails to validate", () => {
    const dir = nodePath.join(projectPath, ".agents", "canvases", "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "canvas.json"), JSON.stringify({ name: "broken" })); // missing required fields
    expect(getProjectCanvasTrustStatus(db, projectId, projectPath, "broken")).toBeNull();
  });

  it("reports trusted after granting, and re-locks after the content changes", () => {
    writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    trustProjectCanvas(db, projectId, projectPath, "widgets");

    const trusted = getProjectCanvasTrustStatus(db, projectId, projectPath, "widgets");
    expect(trusted?.trusted).toBe(true);
    expect(trusted?.trustedAt).not.toBeNull();

    fs.writeFileSync(projectDefDir("widgets") + "/server.mjs", "export default { edited: true };");
    const changed = getProjectCanvasTrustStatus(db, projectId, projectPath, "widgets");
    expect(changed?.trusted).toBe(false);
    expect(changed?.trustedAt).toBeNull();
  });
});

describe("isProjectCanvasTrusted", () => {
  it("is false before trust is granted, true after, and false again once edited", () => {
    writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets")).toBe(false);

    trustProjectCanvas(db, projectId, projectPath, "widgets");
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets")).toBe(true);

    fs.writeFileSync(projectDefDir("widgets") + "/canvas.json", JSON.stringify({
      name: "widgets",
      description: "edited",
      version: 1,
      server: "server.mjs",
      ui: "ui/index.html",
    }));
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets")).toBe(false);
  });

  // #227 review round 3: before this, only getProjectCanvasTrustStatus
  // checked for a symlink — isProjectCanvasTrusted (the function that
  // actually gates whether a host is allowed to spawn) didn't, so the two
  // could disagree: the UI would show "blocked" while a host still happily
  // started. This proves they're folded into the same check now.
  it("goes false once a symlink appears in an already-trusted definition", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    trustProjectCanvas(db, projectId, projectPath, "widgets");
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets")).toBe(true);

    fs.writeFileSync(nodePath.join(dir, "real.mjs"), "export const x = 1;");
    fs.symlinkSync(nodePath.join(dir, "real.mjs"), nodePath.join(dir, "lib.mjs"));
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets")).toBe(false);
  });

  // #227 review round 3: content_hash never covers node_modules (by design —
  // see computeCanvasContentHash's docstring), so nothing previously
  // re-verified it after bun install populated it. A write into it afterward
  // (a git pull adding files, a manual edit) kept resolving as trusted
  // forever even though the import-scope confinement treats it as in-scope
  // code. deps_hash re-verification closes that.
  it("goes false once a file changes inside the definition's own node_modules after trusting", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const pkgFile = nodePath.join(dir, "node_modules", "left-pad", "index.js");
    fs.mkdirSync(nodePath.dirname(pkgFile), { recursive: true });
    fs.writeFileSync(pkgFile, "module.exports = {};");

    trustProjectCanvas(db, projectId, projectPath, "widgets");
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets")).toBe(true);

    fs.writeFileSync(pkgFile, "module.exports = { compromised: true };");
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets")).toBe(false);
  });

  // #227 review round 4 (performance): computeCanvasDepsHash reads a
  // definition's whole node_modules tree, measured at ~240ms of synchronous
  // main-thread work for a modest install — too costly to run on every
  // per-turn "is this canvas listable" check. { checkDeps: false } skips only
  // that check; content hash + symlink-freeness are still verified, since
  // those stay cheap (proportional to the definition's own small file set).
  it("{ checkDeps: false } skips the deps-hash check but still catches a content-hash change or a symlink", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const pkgFile = nodePath.join(dir, "node_modules", "left-pad", "index.js");
    fs.mkdirSync(nodePath.dirname(pkgFile), { recursive: true });
    fs.writeFileSync(pkgFile, "module.exports = {};");
    trustProjectCanvas(db, projectId, projectPath, "widgets");

    // A node_modules edit is caught by the default (full) check...
    fs.writeFileSync(pkgFile, "module.exports = { compromised: true };");
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets")).toBe(false);
    // ...but NOT by the deps-skipping fast path — this is the accepted
    // tradeoff: the fast path is only safe for callers that don't gate an
    // actual host spawn (see isProjectCanvasTrusted's docstring).
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets", { checkDeps: false })).toBe(true);

    // A content-hash change (server.mjs itself) is still caught either way.
    fs.writeFileSync(nodePath.join(dir, "server.mjs"), "export default { edited: true };");
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets", { checkDeps: false })).toBe(false);
  });

  it("{ checkDeps: false } still refuses a definition containing a symlink", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    trustProjectCanvas(db, projectId, projectPath, "widgets");
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets", { checkDeps: false })).toBe(true);

    fs.writeFileSync(nodePath.join(dir, "real.mjs"), "export const x = 1;");
    fs.symlinkSync(nodePath.join(dir, "real.mjs"), nodePath.join(dir, "lib.mjs"));
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets", { checkDeps: false })).toBe(false);
  });
});

// ─── Grant / revoke ──────────────────────────────────────────────────────────

describe("trustProjectCanvas / revokeProjectCanvasTrust", () => {
  it("throws CanvasTrustError for a definition that isn't a real project folder", () => {
    expect(() => trustProjectCanvas(db, projectId, projectPath, "does-not-exist")).toThrow(CanvasTrustError);
  });

  it("records a null deps_hash for a definition with no node_modules", () => {
    writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const trust = trustProjectCanvas(db, projectId, projectPath, "widgets");
    expect(trust.deps_hash).toBeNull();
  });

  it("records the current deps_hash for a definition whose node_modules is already populated (post-install)", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    fs.mkdirSync(nodePath.join(dir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = {};");

    const trust = trustProjectCanvas(db, projectId, projectPath, "widgets");
    expect(trust.deps_hash).toBe(computeCanvasDepsHash(dir));
    expect(trust.deps_hash).not.toBeNull();
  });

  it("revoke is idempotent and un-trusts a previously trusted definition", () => {
    writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    trustProjectCanvas(db, projectId, projectPath, "widgets");
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets")).toBe(true);

    revokeProjectCanvasTrust(db, projectId, "widgets");
    expect(isProjectCanvasTrusted(db, projectId, projectPath, "widgets")).toBe(false);

    // Revoking again (already revoked) is a no-op, not an error.
    expect(() => revokeProjectCanvasTrust(db, projectId, "widgets")).not.toThrow();
  });
});

// ─── Trust-gated resolution ──────────────────────────────────────────────────

describe("resolveTrustedCanvasServerPath", () => {
  it("resolves the built-in tier unconditionally (real kanban, no trust needed)", () => {
    const canvas = createCanvas(db, { projectId, definition: "kanban", title: "Board" });
    const resolved = resolveTrustedCanvasServerPath(db, canvas, projectPath);
    expect(resolved).not.toBeNull();
    expect(resolved).toMatch(/kanban[/\\]server\.mjs$/);
  });

  it("refuses an untrusted project-tier definition", () => {
    writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const canvas = createCanvas(db, { projectId, definition: "widgets", title: "Widgets" });
    expect(resolveTrustedCanvasServerPath(db, canvas, projectPath)).toBeNull();
  });

  it("resolves a trusted project-tier definition", () => {
    writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const canvas = createCanvas(db, { projectId, definition: "widgets", title: "Widgets" });
    trustProjectCanvas(db, projectId, projectPath, "widgets");
    const resolved = resolveTrustedCanvasServerPath(db, canvas, projectPath);
    expect(resolved).toBe(nodePath.join(projectDefDir("widgets"), "server.mjs"));
  });

  it("refuses a trusted-but-since-edited project-tier definition", () => {
    writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const canvas = createCanvas(db, { projectId, definition: "widgets", title: "Widgets" });
    trustProjectCanvas(db, projectId, projectPath, "widgets");
    fs.writeFileSync(nodePath.join(projectDefDir("widgets"), "server.mjs"), "export default { edited: true };");
    expect(resolveTrustedCanvasServerPath(db, canvas, projectPath)).toBeNull();
  });

  it("{ checkDeps: false } passes through to isProjectCanvasTrusted, still resolving a trusted definition (#227 review round 4)", () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const pkgFile = nodePath.join(dir, "node_modules", "left-pad", "index.js");
    fs.mkdirSync(nodePath.dirname(pkgFile), { recursive: true });
    fs.writeFileSync(pkgFile, "module.exports = {};");
    const canvas = createCanvas(db, { projectId, definition: "widgets", title: "Widgets" });
    trustProjectCanvas(db, projectId, projectPath, "widgets");

    fs.writeFileSync(pkgFile, "module.exports = { compromised: true };");
    // The default (checkDeps: true) refuses — a real spawn must never miss this.
    expect(resolveTrustedCanvasServerPath(db, canvas, projectPath)).toBeNull();
    // The perf fast path still resolves it, since it skips only the deps check.
    expect(resolveTrustedCanvasServerPath(db, canvas, projectPath, { checkDeps: false })).toBe(
      nodePath.join(projectDefDir("widgets"), "server.mjs")
    );
  });
});

// ─── Dependency install ──────────────────────────────────────────────────────

describe("installCanvasDependencies", () => {
  it("is a no-op when there is no package.json", async () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets");
    const result = await installCanvasDependencies(dir);
    expect(result).toEqual({ ok: true, output: "" });
  });

  it("runs the injected spawn, collecting stdout/stderr and streaming via onOutput", async () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets", {
      extraFiles: { "package.json": JSON.stringify({ dependencies: { zod: "^3" } }) },
    });

    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    _setCanvasInstallSpawnForTests((command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      (child as unknown as { stdout: EventEmitter }).stdout = stdout;
      (child as unknown as { stderr: EventEmitter }).stderr = stderr;
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from("resolved 1 package\n"));
        stderr.emit("data", Buffer.from("warning: something\n"));
        child.emit("exit", 0);
      });
      return child;
    });

    const chunks: string[] = [];
    const result = await installCanvasDependencies(dir, { onOutput: (c) => chunks.push(c) });

    expect(calls).toEqual([{ command: "bun", args: ["install"], cwd: dir }]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("resolved 1 package");
    expect(result.output).toContain("warning: something");
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("reports failure on a non-zero exit code", async () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets", {
      extraFiles: { "package.json": JSON.stringify({ dependencies: { zod: "^3" } }) },
    });
    _setCanvasInstallSpawnForTests(() => {
      const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
      (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });

    const result = await installCanvasDependencies(dir);
    expect(result.ok).toBe(false);
  });

  it("reports failure when the spawn itself throws", async () => {
    const dir = writeDefinition(nodePath.join(projectPath, ".agents", "canvases"), "widgets", {
      extraFiles: { "package.json": JSON.stringify({}) },
    });
    _setCanvasInstallSpawnForTests(() => {
      throw new Error("ENOENT: bun not found");
    });

    const result = await installCanvasDependencies(dir);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("bun not found");
  });
});
