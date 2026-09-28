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
  getProjectCanvasTrustStatus,
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
});

// ─── Grant / revoke ──────────────────────────────────────────────────────────

describe("trustProjectCanvas / revokeProjectCanvasTrust", () => {
  it("throws CanvasTrustError for a definition that isn't a real project folder", () => {
    expect(() => trustProjectCanvas(db, projectId, projectPath, "does-not-exist")).toThrow(CanvasTrustError);
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
