// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db";
import {
  CANVAS_STATE_MAX_BYTES,
  createCanvas,
  deleteCanvas,
  getCanvas,
  getCanvasState,
  getCanvasTrust,
  isCanvasAttached,
  listCanvases,
  renameCanvas,
  setCanvasAttached,
  setCanvasState,
  setCanvasTrust,
} from "./store";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'P', '/tmp/p1', 'now')").run();
  db.prepare(
    "INSERT INTO sessions (id, project_id, title, status, created_at) VALUES ('s1', 'p1', 'S', 'idle', 'now')"
  ).run();
});

describe("createCanvas / getCanvas", () => {
  it("creates a canvas seeded from an initial state and defaults revision to 0", () => {
    const canvas = createCanvas(db, {
      projectId: "p1",
      definition: "kanban",
      title: "Release board",
      initialState: { columns: { todo: [], doing: [], done: [] } },
    });

    expect(canvas.revision).toBe(0);
    expect(canvas.project_id).toBe("p1");
    expect(canvas.state).toEqual({ columns: { todo: [], doing: [], done: [] } });

    const fetched = getCanvas(db, canvas.id);
    expect(fetched).toEqual(canvas);
  });

  it("defaults state to null when no initialState is supplied", () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "checklist", title: "Todo" });
    expect(canvas.state).toBeNull();
  });

  it("returns null for an unknown id", () => {
    expect(getCanvas(db, "missing")).toBeNull();
  });
});

describe("listCanvases", () => {
  it("lists a project's canvases oldest-first, reporting attachment for the given session", () => {
    const a = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });
    const b = createCanvas(db, { projectId: "p1", definition: "kanban", title: "B" });
    setCanvasAttached(db, "s1", a.id, true);

    const list = listCanvases(db, "p1", "s1");
    expect(list.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(list.find((c) => c.id === a.id)!.attached).toBe(true);
    expect(list.find((c) => c.id === b.id)!.attached).toBe(false);
  });

  it("reports attached: false for every item when no sessionId is given", () => {
    const a = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });
    setCanvasAttached(db, "s1", a.id, true);

    const list = listCanvases(db, "p1");
    expect(list.every((c) => c.attached === false)).toBe(true);
  });

  it("scopes listing to the given project", () => {
    db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p2', 'P2', '/tmp/p2', 'now')").run();
    createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });
    createCanvas(db, { projectId: "p2", definition: "kanban", title: "B" });

    expect(listCanvases(db, "p1")).toHaveLength(1);
    expect(listCanvases(db, "p2")).toHaveLength(1);
  });
});

describe("renameCanvas", () => {
  it("renames an existing canvas and bumps updated_at", () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Old" });
    const renamed = renameCanvas(db, canvas.id, "New");
    expect(renamed?.title).toBe("New");
    expect(getCanvas(db, canvas.id)!.title).toBe("New");
  });

  it("returns null for an unknown id", () => {
    expect(renameCanvas(db, "missing", "New")).toBeNull();
  });
});

describe("deleteCanvas", () => {
  it("removes the canvas and cascades its session attachments", () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });
    setCanvasAttached(db, "s1", canvas.id, true);

    deleteCanvas(db, canvas.id);

    expect(getCanvas(db, canvas.id)).toBeNull();
    expect(isCanvasAttached(db, "s1", canvas.id)).toBe(false);
  });

  it("cascades when its owning project is deleted", () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });
    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();
    expect(getCanvas(db, canvas.id)).toBeNull();
  });

  it("is a no-op deleting an already-removed session's attachment (project cascade only touches the canvas row)", () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });
    setCanvasAttached(db, "s1", canvas.id, true);

    // Deleting the session removes only its attachment; the canvas outlives it.
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    expect(getCanvas(db, canvas.id)).not.toBeNull();
  });
});

describe("setCanvasAttached / isCanvasAttached", () => {
  it("attaches and detaches idempotently", () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });

    expect(isCanvasAttached(db, "s1", canvas.id)).toBe(false);
    setCanvasAttached(db, "s1", canvas.id, true);
    expect(isCanvasAttached(db, "s1", canvas.id)).toBe(true);
    // Attaching again must not throw (INSERT OR IGNORE on the PK).
    expect(() => setCanvasAttached(db, "s1", canvas.id, true)).not.toThrow();
    expect(isCanvasAttached(db, "s1", canvas.id)).toBe(true);

    setCanvasAttached(db, "s1", canvas.id, false);
    expect(isCanvasAttached(db, "s1", canvas.id)).toBe(false);
    // Detaching again must not throw.
    expect(() => setCanvasAttached(db, "s1", canvas.id, false)).not.toThrow();
  });
});

describe("getCanvasState / setCanvasState", () => {
  it("bumps revision and updated_at on every write", () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });
    expect(canvas.revision).toBe(0);

    const v1 = setCanvasState(db, canvas.id, { count: 1 });
    expect(v1.revision).toBe(1);
    expect(v1.state).toEqual({ count: 1 });
    expect(getCanvasState(db, canvas.id)).toEqual({ count: 1 });

    const v2 = setCanvasState(db, canvas.id, { count: 2 });
    expect(v2.revision).toBe(2);
  });

  it("rejects state over the 1 MB cap and leaves the stored state unchanged", () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "A" });
    setCanvasState(db, canvas.id, { seed: true });

    const oversized = { blob: "x".repeat(CANVAS_STATE_MAX_BYTES) };
    expect(() => setCanvasState(db, canvas.id, oversized)).toThrow(/must be at most/);

    const unchanged = getCanvas(db, canvas.id)!;
    expect(unchanged.state).toEqual({ seed: true });
    expect(unchanged.revision).toBe(1);
  });

  it("rejects an oversized initial state at creation time", () => {
    expect(() =>
      createCanvas(db, {
        projectId: "p1",
        definition: "kanban",
        title: "A",
        initialState: { blob: "x".repeat(CANVAS_STATE_MAX_BYTES) },
      })
    ).toThrow(/must be at most/);
  });

  it("throws for an unknown canvas id", () => {
    expect(() => getCanvasState(db, "missing")).toThrow(/not found/i);
    expect(() => setCanvasState(db, "missing", {})).toThrow(/not found/i);
  });
});

describe("canvas trust", () => {
  it("returns null before a definition has been trusted", () => {
    expect(getCanvasTrust(db, "p1", "kanban")).toBeNull();
  });

  it("records and updates a trust record for a project + definition pair", () => {
    const trusted = setCanvasTrust(db, "p1", "kanban", "hash-1");
    expect(trusted.content_hash).toBe("hash-1");

    const fetched = getCanvasTrust(db, "p1", "kanban");
    expect(fetched?.content_hash).toBe("hash-1");

    // Re-trusting after an edit (new content hash) upserts rather than duplicating.
    const retrusted = setCanvasTrust(db, "p1", "kanban", "hash-2");
    expect(retrusted.content_hash).toBe("hash-2");
    expect(getCanvasTrust(db, "p1", "kanban")?.content_hash).toBe("hash-2");
    expect(
      db.prepare("SELECT COUNT(*) as n FROM canvas_trust WHERE project_id = 'p1' AND definition = 'kanban'").get()
    ).toEqual({ n: 1 });
  });

  it("cascades when the owning project is deleted", () => {
    setCanvasTrust(db, "p1", "kanban", "hash-1");
    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();
    expect(getCanvasTrust(db, "p1", "kanban")).toBeNull();
  });
});
