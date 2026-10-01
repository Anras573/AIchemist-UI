// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

// Capture every ipcMain.handle registration so we can invoke the wrapped handler
// (which runs the zod validators, exactly as in production).
const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}));

import { migrate } from "../db";
import { createCanvas, getCanvas, isCanvasAttached } from "../canvas/store";
import { _setCanvasesRootForTests } from "../canvas/definitions";
import { _setCanvasInstallSpawnForTests } from "../canvas/trust";
import { registerCanvasHandlers, type CanvasHostManagerLike } from "./canvas-handlers";
import type { CanvasHostStatus, StartCanvasHostOptions } from "../canvas/host-manager";
import * as CH from "../ipc-channels";
import type { IpcEnvelope } from "./errors";
import type { CanvasTrustStatus } from "../../src/types/index";

// ─── Fake host manager ───────────────────────────────────────────────────────
// Mirrors the manager's real observable behavior just enough to exercise the
// handlers: start()/restart() resolve (or reject, per test), setPanelOpen and
// sendUiMessage record their calls, getStatus reflects whatever the test set.

class FakeHostManager implements CanvasHostManagerLike {
  statuses = new Map<string, CanvasHostStatus>();
  startCalls: Array<{ canvasId: string; opts: StartCanvasHostOptions }> = [];
  restartCalls: Array<{ canvasId: string; opts: StartCanvasHostOptions }> = [];
  panelOpenCalls: Array<{ canvasId: string; open: boolean }> = [];
  uiMessageCalls: Array<{ canvasId: string; message: unknown }> = [];
  startError: Error | null = null;
  restartError: Error | null = null;
  stopCalls: string[] = [];

  async start(canvasId: string, opts: StartCanvasHostOptions): Promise<void> {
    this.startCalls.push({ canvasId, opts });
    if (this.startError) throw this.startError;
    this.statuses.set(canvasId, "running");
  }

  async restart(canvasId: string, opts: StartCanvasHostOptions): Promise<void> {
    this.restartCalls.push({ canvasId, opts });
    if (this.restartError) throw this.restartError;
    this.statuses.set(canvasId, "running");
  }

  async stop(canvasId: string): Promise<void> {
    this.stopCalls.push(canvasId);
    this.statuses.set(canvasId, "stopped");
  }

  setPanelOpen(canvasId: string, open: boolean): void {
    this.panelOpenCalls.push({ canvasId, open });
  }

  sendUiMessage(canvasId: string, message: unknown): void {
    this.uiMessageCalls.push({ canvasId, message });
  }

  getStatus(canvasId: string): CanvasHostStatus | undefined {
    return this.statuses.get(canvasId);
  }
}

let db: Database.Database;
let hostManager: FakeHostManager;

/** Invoke a captured handler and return its (already-unwrapped) envelope. */
async function call<T>(channel: string, payload: unknown): Promise<IpcEnvelope<T>> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  return (await fn({} as unknown, payload)) as IpcEnvelope<T>;
}

beforeEach(() => {
  handlers.clear();
  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'P', '/tmp/p1', 'now')").run();
  db.prepare(
    "INSERT INTO sessions (id, project_id, title, status, created_at) VALUES ('s1', 'p1', 'S', 'idle', 'now')"
  ).run();
  hostManager = new FakeHostManager();
  registerCanvasHandlers(db, hostManager);
});

describe("CANVAS_CREATE", () => {
  it("creates a canvas seeded from the supplied initial state", async () => {
    const env = await call<{ id: string; title: string; state: unknown }>(CH.CANVAS_CREATE, {
      projectId: "p1",
      definition: "kanban",
      title: "Board",
      initialState: { columns: [] },
    });
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.title).toBe("Board");
    expect(env.data.state).toEqual({ columns: [] });
    expect(getCanvas(db, env.data.id)).not.toBeNull();
  });

  it("rejects a missing title", async () => {
    const env = await call(CH.CANVAS_CREATE, { projectId: "p1", definition: "kanban", title: "" });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe("invalid_input");
  });

  it("rejects a whitespace-only projectId", async () => {
    const env = await call(CH.CANVAS_CREATE, { projectId: "   ", definition: "kanban", title: "Board" });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe("invalid_input");
  });
});

describe("CANVAS_LIST_DEFINITIONS", () => {
  let globalRoot: string;
  let projectDir: string;

  beforeEach(() => {
    globalRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-handlers-global-"));
    projectDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-handlers-project-"));
    _setCanvasesRootForTests(globalRoot);
    db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p2', 'P2', ?, 'now')").run(projectDir);
  });

  afterEach(() => {
    fs.rmSync(globalRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    _setCanvasesRootForTests(null);
  });

  function writeManifest(root: string, name: string): void {
    const dir = nodePath.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      nodePath.join(dir, "canvas.json"),
      JSON.stringify({ name, description: "", version: 1, server: "server.mjs", ui: "ui/index.html" })
    );
  }

  it("includes the built-in tier even with no projectId", async () => {
    const env = await call<{ definitions: Array<{ id: string; tier: string }>; errors: unknown[] }>(
      CH.CANVAS_LIST_DEFINITIONS,
      {}
    );
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.definitions.some((d) => d.id === "kanban" && d.tier === "builtin")).toBe(true);
  });

  it("resolves the project tier from the given projectId's path", async () => {
    writeManifest(nodePath.join(projectDir, ".agents", "canvases"), "board");

    const env = await call<{ definitions: Array<{ id: string; tier: string }>; errors: unknown[] }>(
      CH.CANVAS_LIST_DEFINITIONS,
      { projectId: "p2" }
    );
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.definitions).toContainEqual(expect.objectContaining({ id: "board", tier: "project" }));
  });

  it("surfaces a manifest error without breaking the rest of the listing", async () => {
    fs.mkdirSync(nodePath.join(globalRoot, "broken"), { recursive: true }); // no canvas.json
    writeManifest(globalRoot, "sqlite-browser");

    const env = await call<{ definitions: Array<{ id: string }>; errors: Array<{ id: string; tier: string }> }>(
      CH.CANVAS_LIST_DEFINITIONS,
      {}
    );
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.definitions.some((d) => d.id === "sqlite-browser")).toBe(true);
    expect(env.data.errors).toContainEqual(expect.objectContaining({ id: "broken", tier: "global" }));
  });
});

describe("CANVAS_LIST", () => {
  it("lists a project's canvases with attachment for the given session", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });

    const before = await call<Array<{ id: string; attached: boolean }>>(CH.CANVAS_LIST, {
      projectId: "p1",
      sessionId: "s1",
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.data.find((c) => c.id === canvas.id)?.attached).toBe(false);

    await call(CH.CANVAS_ATTACH, { sessionId: "s1", canvasId: canvas.id, attached: true });

    const after = await call<Array<{ id: string; attached: boolean }>>(CH.CANVAS_LIST, {
      projectId: "p1",
      sessionId: "s1",
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.find((c) => c.id === canvas.id)?.attached).toBe(true);
  });
});

describe("CANVAS_RENAME", () => {
  it("renames an existing canvas", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Old" });
    const env = await call<{ title: string }>(CH.CANVAS_RENAME, { canvasId: canvas.id, title: "New" });
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.title).toBe("New");
  });

  it("returns not_found for an unknown canvas", async () => {
    const env = await call(CH.CANVAS_RENAME, { canvasId: "missing", title: "New" });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe("not_found");
  });

  it("rejects an empty title", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Old" });
    const env = await call(CH.CANVAS_RENAME, { canvasId: canvas.id, title: "" });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe("invalid_input");
  });
});

describe("CANVAS_DELETE", () => {
  it("deletes an existing canvas", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });
    const env = await call<{ ok: boolean }>(CH.CANVAS_DELETE, { canvasId: canvas.id });
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.ok).toBe(true);
    expect(getCanvas(db, canvas.id)).toBeNull();
  });

  it("is a no-op (still ok) deleting an already-missing canvas", async () => {
    const env = await call<{ ok: boolean }>(CH.CANVAS_DELETE, { canvasId: "missing" });
    expect(env.ok).toBe(true);
  });
});

describe("CANVAS_ATTACH", () => {
  it("attaches and detaches a canvas for a session", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });

    const attach = await call<{ attached: boolean }>(CH.CANVAS_ATTACH, {
      sessionId: "s1",
      canvasId: canvas.id,
      attached: true,
    });
    expect(attach.ok).toBe(true);
    if (!attach.ok) return;
    expect(attach.data.attached).toBe(true);
    expect(isCanvasAttached(db, "s1", canvas.id)).toBe(true);

    const detach = await call<{ attached: boolean }>(CH.CANVAS_ATTACH, {
      sessionId: "s1",
      canvasId: canvas.id,
      attached: false,
    });
    expect(detach.ok).toBe(true);
    if (!detach.ok) return;
    expect(detach.data.attached).toBe(false);
    expect(isCanvasAttached(db, "s1", canvas.id)).toBe(false);
  });

  it("returns not_found for an unknown canvas", async () => {
    const env = await call(CH.CANVAS_ATTACH, { sessionId: "s1", canvasId: "missing", attached: true });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe("not_found");
  });

  it("rejects a non-boolean attached value", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });
    const env = await call(CH.CANVAS_ATTACH, { sessionId: "s1", canvasId: canvas.id, attached: "yes" });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe("invalid_input");
  });
});

// ─── Panel lifecycle (#224) ─────────────────────────────────────────────────

describe("CANVAS_OPEN / CANVAS_CLOSE / CANVAS_UI_MESSAGE / CANVAS_RESTART", () => {
  let canvasesRoot: string;

  beforeEach(() => {
    canvasesRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-handlers-"));
    _setCanvasesRootForTests(canvasesRoot);
  });

  afterEach(() => {
    fs.rmSync(canvasesRoot, { recursive: true, force: true });
    _setCanvasesRootForTests(null);
  });

  function writeServerModule(definition: string): void {
    const dir = nodePath.join(canvasesRoot, definition);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "server.mjs"), "export default {};");
  }

  describe("CANVAS_OPEN", () => {
    it("starts the host, marks the panel open, and returns the persisted state + status", async () => {
      writeServerModule("kanban");
      const canvas = createCanvas(db, {
        projectId: "p1",
        definition: "kanban",
        title: "Board",
        initialState: { columns: [] },
      });

      const env = await call<{ state: unknown; revision: number; status: string }>(CH.CANVAS_OPEN, {
        canvasId: canvas.id,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.state).toEqual({ columns: [] });
      expect(env.data.revision).toBe(0);
      expect(env.data.status).toBe("running");

      expect(hostManager.startCalls).toHaveLength(1);
      expect(hostManager.startCalls[0]?.canvasId).toBe(canvas.id);
      expect(hostManager.startCalls[0]?.opts.projectId).toBe("p1");
      expect(hostManager.startCalls[0]?.opts.projectPath).toBe("/tmp/p1");
      expect(hostManager.panelOpenCalls).toEqual([{ canvasId: canvas.id, open: true }]);
    });

    it("still opens the panel and returns persisted state when the definition has no server.mjs", async () => {
      // No writeServerModule() call — resolveCanvasServerPath("missing-def") is null.
      const canvas = createCanvas(db, { projectId: "p1", definition: "missing-def", title: "Board" });

      const env = await call<{ state: unknown; revision: number; status: string }>(CH.CANVAS_OPEN, {
        canvasId: canvas.id,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.status).toBe("unknown");
      expect(hostManager.startCalls).toHaveLength(0);
      expect(hostManager.panelOpenCalls).toEqual([{ canvasId: canvas.id, open: true }]);
    });

    it("still opens the panel when the host fails to start", async () => {
      writeServerModule("kanban");
      const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
      hostManager.startError = new Error("boom");

      const env = await call<{ status: string }>(CH.CANVAS_OPEN, { canvasId: canvas.id });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(hostManager.panelOpenCalls).toEqual([{ canvasId: canvas.id, open: true }]);
    });

    it("returns not_found for an unknown canvas", async () => {
      const env = await call(CH.CANVAS_OPEN, { canvasId: "missing" });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe("not_found");
    });
  });

  describe("CANVAS_CLOSE", () => {
    it("marks the panel closed and returns the persisted state", async () => {
      const canvas = createCanvas(db, {
        projectId: "p1",
        definition: "kanban",
        title: "Board",
        initialState: { columns: [] },
      });

      const env = await call<{ state: unknown; revision: number }>(CH.CANVAS_CLOSE, { canvasId: canvas.id });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.state).toEqual({ columns: [] });
      expect(hostManager.panelOpenCalls).toEqual([{ canvasId: canvas.id, open: false }]);
    });
  });

  describe("CANVAS_UI_MESSAGE", () => {
    it("relays the message to the host manager", async () => {
      const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
      const env = await call<{ ok: boolean }>(CH.CANVAS_UI_MESSAGE, {
        canvasId: canvas.id,
        message: { type: "move", id: "1" },
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.ok).toBe(true);
      expect(hostManager.uiMessageCalls).toEqual([
        { canvasId: canvas.id, message: { type: "move", id: "1" } },
      ]);
    });
  });

  describe("CANVAS_RESTART", () => {
    it("restarts the host and returns the refreshed status", async () => {
      writeServerModule("kanban");
      const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });

      const env = await call<{ status: string }>(CH.CANVAS_RESTART, { canvasId: canvas.id });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.status).toBe("running");
      expect(hostManager.restartCalls).toHaveLength(1);
    });

    it("returns unavailable when the definition can't be resolved", async () => {
      const canvas = createCanvas(db, { projectId: "p1", definition: "missing-def", title: "Board" });
      const env = await call(CH.CANVAS_RESTART, { canvasId: canvas.id });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe("unavailable");
      expect(hostManager.restartCalls).toHaveLength(0);
    });

    it("returns not_found for an unknown canvas", async () => {
      const env = await call(CH.CANVAS_RESTART, { canvasId: "missing" });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe("not_found");
    });
  });
});

// ─── Trust (#227) ─────────────────────────────────────────────────────────────

describe("CANVAS_TRUST_STATUS / CANVAS_TRUST_GRANT / CANVAS_TRUST_REVOKE", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-trust-project-"));
    db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p3', 'P3', ?, 'now')").run(projectDir);
    _setCanvasInstallSpawnForTests(null);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    _setCanvasInstallSpawnForTests(null);
  });

  function writeDefinition(name: string, serverBody = "export default {};", extraFiles: Record<string, string> = {}): void {
    const dir = nodePath.join(projectDir, ".agents", "canvases", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      nodePath.join(dir, "canvas.json"),
      JSON.stringify({ name, description: "A widget board", version: 1, server: "server.mjs", ui: "ui/index.html" })
    );
    fs.writeFileSync(nodePath.join(dir, "server.mjs"), serverBody);
    for (const [name_, content] of Object.entries(extraFiles)) {
      fs.writeFileSync(nodePath.join(dir, name_), content);
    }
  }

  describe("CANVAS_TRUST_STATUS", () => {
    it("reports untrusted for a never-granted project definition", async () => {
      writeDefinition("widgets");
      const env = await call<CanvasTrustStatus>(CH.CANVAS_TRUST_STATUS, { projectId: "p3", definition: "widgets" });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data?.trusted).toBe(false);
      expect(env.data?.trustedAt).toBeNull();
      expect(env.data?.dependencies).toEqual({ names: [], hasPackageJson: false });
    });

    it("returns null for a folder that isn't a valid project definition", async () => {
      const env = await call<CanvasTrustStatus | null>(CH.CANVAS_TRUST_STATUS, {
        projectId: "p3",
        definition: "does-not-exist",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data).toBeNull();
    });

    it("returns not_found for an unknown project", async () => {
      const env = await call(CH.CANVAS_TRUST_STATUS, { projectId: "no-such-project", definition: "widgets" });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe("not_found");
    });
  });

  /** Fetches the current CANVAS_TRUST_STATUS hash and grants with it, mirroring what the renderer does. */
  async function grantTrust(definition: string): Promise<IpcEnvelope<{ trust: { content_hash: string }; install: { ok: boolean; output: string } }>> {
    const status = await call<CanvasTrustStatus>(CH.CANVAS_TRUST_STATUS, { projectId: "p3", definition });
    if (!status.ok || !status.data) throw new Error(`No trust status for ${definition}`);
    return call(CH.CANVAS_TRUST_GRANT, { projectId: "p3", definition, expectedContentHash: status.data.contentHash });
  }

  describe("CANVAS_TRUST_GRANT", () => {
    it("records trust and reports it back via CANVAS_TRUST_STATUS", async () => {
      writeDefinition("widgets");
      const grant = await grantTrust("widgets");
      expect(grant.ok).toBe(true);
      if (!grant.ok) return;
      // No package.json — install is a no-op rather than actually spawning bun.
      expect(grant.data.install).toEqual({ ok: true, output: "" });

      const status = await call<CanvasTrustStatus>(CH.CANVAS_TRUST_STATUS, {
        projectId: "p3",
        definition: "widgets",
      });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.data?.trusted).toBe(true);
      expect(status.data?.contentHash).toBe(grant.data.trust.content_hash);
    });

    it("lets CANVAS_OPEN start the host once trust is granted, and refuses before", async () => {
      writeDefinition("widgets");
      const canvas = createCanvas(db, { projectId: "p3", definition: "widgets", title: "Widgets" });

      const beforeOpen = await call<{ status: string }>(CH.CANVAS_OPEN, { canvasId: canvas.id });
      expect(beforeOpen.ok).toBe(true);
      if (beforeOpen.ok) expect(beforeOpen.data.status).toBe("unknown");
      expect(hostManager.startCalls).toHaveLength(0);

      await grantTrust("widgets");

      const afterOpen = await call<{ status: string }>(CH.CANVAS_OPEN, { canvasId: canvas.id });
      expect(afterOpen.ok).toBe(true);
      if (!afterOpen.ok) return;
      expect(afterOpen.data.status).toBe("running");
      expect(hostManager.startCalls).toHaveLength(1);
    });

    it("runs `bun install` when the definition declares a package.json, streaming through the injected spawn", async () => {
      writeDefinition("widgets", "export default {};", { "package.json": JSON.stringify({ dependencies: { zod: "^3" } }) });

      const spawnCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
      _setCanvasInstallSpawnForTests((command, args, options) => {
        spawnCalls.push({ command, args, cwd: options.cwd });
        const fake = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        (fake as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stdout = stdout;
        (fake as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stderr = stderr;
        queueMicrotask(() => {
          stdout.emit("data", Buffer.from("installed 1 package\n"));
          fake.emit("exit", 0);
        });
        return fake;
      });

      const grant = await grantTrust("widgets");
      expect(grant.ok).toBe(true);
      if (!grant.ok) return;
      expect(grant.data.install.ok).toBe(true);
      expect(grant.data.install.output).toContain("installed 1 package");
      expect(spawnCalls).toEqual([{ command: "bun", args: ["install"], cwd: nodePath.join(projectDir, ".agents", "canvases", "widgets") }]);
    });

    it("returns not_found when the definition doesn't exist", async () => {
      const env = await call(CH.CANVAS_TRUST_GRANT, {
        projectId: "p3",
        definition: "does-not-exist",
        expectedContentHash: "irrelevant",
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe("not_found");
    });

    it("rejects with conflict when the definition changed since the displayed hash", async () => {
      writeDefinition("widgets");
      const status = await call<CanvasTrustStatus>(CH.CANVAS_TRUST_STATUS, { projectId: "p3", definition: "widgets" });
      expect(status.ok).toBe(true);
      if (!status.ok || !status.data) return;

      // Edit after the hash was displayed but before the user clicks "Trust".
      writeDefinition("widgets", "export default { edited: true };");

      const env = await call(CH.CANVAS_TRUST_GRANT, {
        projectId: "p3",
        definition: "widgets",
        expectedContentHash: status.data.contentHash,
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe("conflict");
      // Never grants trust for content the user didn't actually review.
      const after = await call<CanvasTrustStatus>(CH.CANVAS_TRUST_STATUS, { projectId: "p3", definition: "widgets" });
      expect(after.ok && after.data?.trusted).toBe(false);
    });

    it("refuses to grant while a pre-existing node_modules sits in the definition folder", async () => {
      writeDefinition("widgets");
      fs.mkdirSync(nodePath.join(projectDir, ".agents", "canvases", "widgets", "node_modules", "evil-pkg"), {
        recursive: true,
      });
      fs.writeFileSync(
        nodePath.join(projectDir, ".agents", "canvases", "widgets", "node_modules", "evil-pkg", "index.js"),
        "module.exports = {};"
      );

      const status = await call<CanvasTrustStatus>(CH.CANVAS_TRUST_STATUS, { projectId: "p3", definition: "widgets" });
      expect(status.ok).toBe(true);
      if (!status.ok || !status.data) return;

      const env = await call(CH.CANVAS_TRUST_GRANT, {
        projectId: "p3",
        definition: "widgets",
        expectedContentHash: status.data.contentHash,
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe("invalid_input");
      expect(env.error.message).toMatch(/node_modules/);
    });

    it("refuses to grant while the definition contains a symlink", async () => {
      writeDefinition("widgets");
      const defDir = nodePath.join(projectDir, ".agents", "canvases", "widgets");
      fs.writeFileSync(nodePath.join(defDir, "real.mjs"), "export const x = 1;");
      fs.symlinkSync(nodePath.join(defDir, "real.mjs"), nodePath.join(defDir, "lib.mjs"));

      const status = await call<CanvasTrustStatus>(CH.CANVAS_TRUST_STATUS, { projectId: "p3", definition: "widgets" });
      expect(status.ok).toBe(true);
      if (!status.ok || !status.data) return;
      expect(status.data.blockedReason).toMatch(/symlink/i);

      const env = await call(CH.CANVAS_TRUST_GRANT, {
        projectId: "p3",
        definition: "widgets",
        expectedContentHash: status.data.contentHash,
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe("invalid_input");
      expect(env.error.message).toMatch(/symlink/i);
    });
  });

  describe("CANVAS_TRUST_REVOKE", () => {
    it("un-trusts the definition and stops any running host using it", async () => {
      writeDefinition("widgets");
      const canvas = createCanvas(db, { projectId: "p3", definition: "widgets", title: "Widgets" });
      await grantTrust("widgets");
      await call(CH.CANVAS_OPEN, { canvasId: canvas.id });
      expect(hostManager.getStatus(canvas.id)).toBe("running");

      const revoke = await call<{ ok: boolean }>(CH.CANVAS_TRUST_REVOKE, { projectId: "p3", definition: "widgets" });
      expect(revoke.ok).toBe(true);
      expect(hostManager.stopCalls).toEqual([canvas.id]);
      expect(hostManager.getStatus(canvas.id)).toBe("stopped");

      const status = await call<CanvasTrustStatus>(CH.CANVAS_TRUST_STATUS, {
        projectId: "p3",
        definition: "widgets",
      });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.data?.trusted).toBe(false);
    });

    it("is a no-op when the definition was never trusted", async () => {
      const env = await call<{ ok: boolean }>(CH.CANVAS_TRUST_REVOKE, { projectId: "p3", definition: "widgets" });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.data.ok).toBe(true);
      expect(hostManager.stopCalls).toEqual([]);
    });
  });
});

describe("pop-out (#248)", () => {
  it("keeps the host open until the last view (panel or pop-out) closes", async () => {
    const c = ((await call<{ id: string }>(CH.CANVAS_CREATE, { projectId: "p1", definition: "kanban", title: "B" })) as { ok: true; data: { id: string } }).data;
    const as = (id: number, channel: string) =>
      (handlers.get(channel) as (...a: unknown[]) => Promise<unknown>)({ sender: { id } }, { canvasId: c.id });
    await as(1, CH.CANVAS_OPEN);
    await as(2, CH.CANVAS_OPEN);
    hostManager.panelOpenCalls.length = 0;
    await as(1, CH.CANVAS_CLOSE);
    expect(hostManager.panelOpenCalls).toEqual([]);
    await as(2, CH.CANVAS_CLOSE);
    expect(hostManager.panelOpenCalls).toEqual([{ canvasId: c.id, open: false }]);
  });

  it("CANVAS_POP_OUT opens a window for an existing canvas and rejects unknown ids", async () => {
    const open = vi.fn();
    handlers.clear();
    registerCanvasHandlers(db, hostManager, { popouts: { open } });
    const c = ((await call<{ id: string }>(CH.CANVAS_CREATE, { projectId: "p1", definition: "kanban", title: "B" })) as { ok: true; data: { id: string } }).data;
    expect((await call(CH.CANVAS_POP_OUT, { canvasId: c.id })).ok).toBe(true);
    expect(open).toHaveBeenCalledWith(c.id, { title: "B", definition: "kanban" });
    expect((await call(CH.CANVAS_POP_OUT, { canvasId: "nope" })).ok).toBe(false);
  });
});
