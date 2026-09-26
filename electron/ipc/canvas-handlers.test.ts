// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { registerCanvasHandlers } from "./canvas-handlers";
import * as CH from "../ipc-channels";
import type { IpcEnvelope } from "./errors";

let db: Database.Database;

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
  registerCanvasHandlers(db);
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
