// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db";

const enqueueTurn = vi.fn();
const hasPendingApproval = vi.fn();
vi.mock("../ipc/agent-turn-queue", () => ({ enqueueTurn: (...a: unknown[]) => enqueueTurn(...a) }));
vi.mock("../agent/approval", () => ({ hasPendingApproval: (id: string) => hasPendingApproval(id) }));

import { AgentBridge, AGENT_SEND_INFLIGHT_EXPIRY_MS, AGENT_SEND_MAX_PER_WINDOW, AGENT_SEND_WINDOW_MS } from "./agent-bridge";
import { createCanvas, setCanvasAttached } from "./store";

let db: Database.Database;
let now: number;
let bridge: AgentBridge;
let canvasId: string;
const send = vi.fn();
const turnCtx = { db: null as never, activeTurns: new Set<string>(), getMainWindow: () => null };

beforeEach(() => {
  enqueueTurn.mockReset().mockReturnValue({ queued: false });
  hasPendingApproval.mockReset().mockReturnValue(false);
  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'P', '/tmp/p1', 'now')").run();
  for (const id of ["s1", "s2"]) {
    db.prepare("INSERT INTO sessions (id, project_id, title, status, created_at) VALUES (?, 'p1', 'S', 'idle', 'now')").run(id);
  }
  canvasId = createCanvas(db, { projectId: "p1", definition: "connect4", title: "C4" }).id;
  now = 1_000_000;
  send.mockReset();
  const win = { webContents: { send } } as never;
  bridge = new AgentBridge({ db, turnCtx: { ...turnCtx, db }, getMainWindow: () => win, now: () => now });
});

const messages = (sid: string) =>
  db.prepare("SELECT role, content, source FROM messages WHERE session_id = ?").all(sid);

describe("AgentBridge target resolution", () => {
  it("uses the only attached session when none is given", () => {
    setCanvasAttached(db, "s1", canvasId, true);
    bridge.send(canvasId, "your move");
    expect(enqueueTurn).toHaveBeenCalledWith(expect.anything(), "s1", expect.objectContaining({ prompt: "your move" }));
  });

  it("errors when no session is attached", () => {
    expect(() => bridge.send(canvasId, "hi")).toThrow(/not attached to any session/);
    expect(enqueueTurn).not.toHaveBeenCalled();
  });

  it("errors when several are attached and none is named", () => {
    setCanvasAttached(db, "s1", canvasId, true);
    setCanvasAttached(db, "s2", canvasId, true);
    expect(() => bridge.send(canvasId, "hi")).toThrow(/multiple sessions/);
  });

  it("accepts an explicit attached session and refuses an unattached one", () => {
    setCanvasAttached(db, "s1", canvasId, true);
    setCanvasAttached(db, "s2", canvasId, true);
    bridge.send(canvasId, "hi", "s2");
    expect(enqueueTurn).toHaveBeenCalledWith(expect.anything(), "s2", expect.anything());
    setCanvasAttached(db, "s2", canvasId, false);
    expect(() => bridge.send(canvasId, "hi", "s2")).toThrow(/not attached to session "s2"/);
  });
});

describe("AgentBridge delivery", () => {
  beforeEach(() => setCanvasAttached(db, "s1", canvasId, true));

  it("persists a user message tagged with the canvas source and enqueues it by id", () => {
    bridge.send(canvasId, "your move");
    expect(messages("s1")).toEqual([{ role: "user", content: "your move", source: "canvas:connect4" }]);
    const id = (db.prepare("SELECT id FROM messages").get() as { id: string }).id;
    expect(enqueueTurn.mock.calls[0][2]).toMatchObject({ messageId: id });
  });

  it("pushes the message to the renderer, flagged queued only when behind a running turn", () => {
    bridge.send(canvasId, "first");
    expect(send.mock.calls[0][1]).toMatchObject({ session_id: "s1", message: { source: "canvas:connect4" } });
    expect(send.mock.calls[0][1].queued).toBeUndefined();

    (enqueueTurn.mock.calls[0][2] as { onSettled: () => void }).onSettled();
    enqueueTurn.mockReturnValue({ queued: true });
    bridge.send(canvasId, "second");
    expect(send.mock.calls[1][1].queued).toBe(true);
  });

  it("refuses while the session awaits an approval, without persisting", () => {
    hasPendingApproval.mockReturnValue(true);
    expect(() => bridge.send(canvasId, "hi")).toThrow(/awaiting user approval/);
    expect(messages("s1")).toEqual([]);
    expect(enqueueTurn).not.toHaveBeenCalled();
  });

  it("refuses empty text", () => {
    expect(() => bridge.send(canvasId, "  ")).toThrow(/must not be empty/);
  });
});

describe("AgentBridge rate limiting", () => {
  beforeEach(() => setCanvasAttached(db, "s1", canvasId, true));

  const settle = () => (enqueueTurn.mock.calls.at(-1)![2] as { onSettled: () => void }).onSettled();

  it("allows only one in-flight send until its turn settles", () => {
    bridge.send(canvasId, "one");
    expect(() => bridge.send(canvasId, "two")).toThrow(/still in flight/);
    settle();
    expect(() => bridge.send(canvasId, "two")).not.toThrow();
  });

  it("a stale send settling after expiry does not clear a newer send's in-flight flag", () => {
    bridge.send(canvasId, "old");
    const oldTurn = enqueueTurn.mock.calls[0][2] as { onSettled: () => void };
    now += AGENT_SEND_INFLIGHT_EXPIRY_MS + 1;
    bridge.send(canvasId, "new");
    oldTurn.onSettled();
    expect(() => bridge.send(canvasId, "third")).toThrow(/still in flight/);
  });

  it("caps sends per minute and recovers after the window", () => {
    for (let i = 0; i < AGENT_SEND_MAX_PER_WINDOW; i++) {
      bridge.send(canvasId, `m${i}`);
      settle();
    }
    expect(() => bridge.send(canvasId, "extra")).toThrow(/rate limit/);
    now += AGENT_SEND_WINDOW_MS + 1;
    expect(() => bridge.send(canvasId, "later")).not.toThrow();
  });
});
