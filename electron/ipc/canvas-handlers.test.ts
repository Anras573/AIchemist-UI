// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
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
import { registerCanvasHandlers, type CanvasHostManagerLike } from "./canvas-handlers";
import type { CanvasHostStatus, StartCanvasHostOptions } from "../canvas/host-manager";
import * as CH from "../ipc-channels";
import type { IpcEnvelope } from "./errors";

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
