// @vitest-environment node
//
// End-to-end proof of the agent <-> canvas loop (#225's acceptance criteria),
// run against the REAL, shipped kanban definition — not a stand-in fixture.
// Wires together the two halves a real turn actually goes through:
//
//   agent tool call --> CanvasMcpEndpoint (real HTTP JSON-RPC) --> CanvasHostManager
//     --> a host process running the real kanban CanvasServerDefinition
//
// The only fake is the process itself (`utilityProcess.fork` can't run inside
// vitest) — `createInProcessHostFactory` below runs a REAL `createCanvasHostRuntime`
// against the REAL kanban definition (`createKanbanDefinition(z)`, the exact
// object `server.mjs` default-exports via `defineCanvas`), keyed by the
// definition's *actually resolved* `server.mjs` path — so this test would
// fail if `resolveCanvasServerPath("kanban")` ever stopped finding the real
// file, same as it would in production.
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

import { migrate } from "../../../db";
import { addProject } from "../../../projects";
import { createSession } from "../../../sessions";
import { createCanvas, getCanvas, setCanvasAttached } from "../../store";
import { resolveCanvasServerPath } from "../../definitions";
import { createCanvasHostRuntime, type HostTransport } from "../../host/runtime";
import {
  CanvasHostManager,
  type CanvasHostProcess,
  type CanvasHostProcessFactory,
} from "../../host-manager";
import { CanvasMcpEndpoint } from "../../mcp-endpoint";
import { createKanbanDefinition } from "./definition.mjs";
import { createBoard } from "./board.mjs";

// ─── Fake host process, running the REAL kanban definition ──────────────────

class FakeCanvasHostProcess extends EventEmitter implements CanvasHostProcess {
  exited = false;
  pid: number | undefined = 1234;
  postMessage(message: unknown): void {
    this.emit("__toHost", message);
  }
  kill(): boolean {
    if (this.exited) return false;
    this.exited = true;
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
}

function createKanbanHostFactory(): { factory: CanvasHostProcessFactory; realServerPath: string } {
  const realServerPath = resolveCanvasServerPath("kanban");
  if (!realServerPath) throw new Error("kanban's server.mjs did not resolve — built-in tier is broken");

  const factory: CanvasHostProcessFactory = (opts) => {
    const proc = new FakeCanvasHostProcess();
    const [serverPath, projectJson] = opts.args;
    if (serverPath !== realServerPath) {
      queueMicrotask(() => proc.emit("message", { type: "init.error", error: `unexpected server path: ${serverPath}` }));
      return proc;
    }
    const project = JSON.parse(projectJson) as { id: string; path: string };
    const transport: HostTransport = {
      send: (msg) => proc.emit("message", msg),
      onMessage: (handler) => proc.on("__toHost", handler),
    };
    // The REAL kanban CanvasServerDefinition — the same object `server.mjs`
    // default-exports (via `defineCanvas`) in the packaged app.
    createCanvasHostRuntime({ definition: createKanbanDefinition(z), transport, project });
    return proc;
  };

  return { factory, realServerPath };
}

// ─── Scaffolding ──────────────────────────────────────────────────────────────

let db: Database.Database;
let projectPath: string;
let projectId: string;
let sessionId: string;
let canvasId: string;
let hostManager: CanvasHostManager;
let endpoint: CanvasMcpEndpoint;
let stateChanges: Array<{ canvasId: string; state: unknown; revision: number }>;

beforeEach(async () => {
  db = new Database(":memory:");
  migrate(db);

  projectPath = fs.mkdtempSync(nodePath.join(os.tmpdir(), "kanban-e2e-"));
  const project = addProject(db, projectPath);
  projectId = project.id;

  const session = createSession(db, projectId, "anthropic");
  sessionId = session.id;

  const canvas = createCanvas(db, { projectId, definition: "kanban", title: "Release board" });
  canvasId = canvas.id;
  setCanvasAttached(db, sessionId, canvasId, true);

  stateChanges = [];
  const { factory } = createKanbanHostFactory();
  hostManager = new CanvasHostManager(db, {
    spawn: factory,
    // This is the exact hook `main.ts` wires to push CANVAS_EVENT to the
    // renderer (see `registerAllHandlers`'s `new CanvasHostManager(db, {
    // hooks: { onStateChanged: (canvasId, state, revision) =>
    // getMainWindow()?.webContents.send(CH.CANVAS_EVENT, ...) } })`) — a fake
    // stand-in the assertions below use to prove "the agent's tool call
    // reaches the open UI immediately" without needing a real BrowserWindow.
    hooks: {
      onStateChanged: (id, state, revision) => stateChanges.push({ canvasId: id, state, revision }),
    },
  });

  endpoint = new CanvasMcpEndpoint({ db, hostManager, getMainWindow: () => null });
  await endpoint.start();
});

afterEach(async () => {
  await endpoint.stop();
  await hostManager.stopAll();
  db.close();
  fs.rmSync(projectPath, { recursive: true, force: true });
});

async function toolsCall(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${endpoint.baseUrl}/canvas/${canvasId}/session/${sessionId}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { content: Array<{ text: string }>; isError?: boolean } };
  const text = body.result?.content[0]?.text ?? "";
  return { isError: body.result?.isError ?? false, value: text ? (JSON.parse(text) as unknown) : undefined };
}

describe("kanban canvas — agent <-> canvas loop, end to end", () => {
  it("get_board returns the fresh, empty board over the real MCP endpoint", async () => {
    const { isError, value } = await toolsCall("get_board", {});
    expect(isError).toBe(false);
    expect(value).toEqual(createBoard());
  });

  it("an agent tool call (move_card) updates the persisted state and fires onStateChanged immediately — what pushes CANVAS_EVENT to an open panel", async () => {
    const added = await toolsCall("add_card", { column: "todo", title: "Ship the kanban canvas" });
    const cardId = (added.value as { card: { id: string } }).card.id;
    stateChanges.length = 0; // only care about the move below

    const moved = await toolsCall("move_card", { id: cardId, to: "done" });
    expect(moved.isError).toBe(false);

    // Persisted in the store (what CANVAS_OPEN would read for a panel opened later) ...
    const persisted = getCanvas(db, canvasId);
    expect((persisted!.state as ReturnType<typeof createBoard>).columns.done.map((c) => c.id)).toEqual([cardId]);

    // ... and pushed via the exact hook that feeds CANVAS_EVENT to an *already open* panel.
    expect(stateChanges).toHaveLength(1);
    const pushedBoard = stateChanges[0].state as ReturnType<typeof createBoard>;
    expect(pushedBoard.columns.done.map((c) => c.id)).toEqual([cardId]);
    expect(pushedBoard.columns.todo).toEqual([]);
  });

  it("a UI edit (onUiMessage, via the same sendUiMessage the CANVAS_UI_MESSAGE IPC handler calls) is visible to the agent on its next get_board", async () => {
    // Starts the host (idempotent — a running host is a no-op) so the UI
    // message below has somewhere to land, exactly like CANVAS_OPEN does
    // before the panel can post anything.
    await toolsCall("get_board", {});

    // The user drags a card in the sandboxed iframe; CanvasFrame relays it via
    // canvasUiMessage -> CANVAS_UI_MESSAGE -> hostManager.sendUiMessage. No
    // tool call, no agent turn involved.
    hostManager.sendUiMessage(canvasId, { type: "add", column: "doing", title: "Added from the UI" });
    await new Promise((resolve) => setImmediate(resolve));

    const { value } = await toolsCall("get_board", {});
    const board = value as ReturnType<typeof createBoard>;
    expect(board.columns.doing).toHaveLength(1);
    expect(board.columns.doing[0].title).toBe("Added from the UI");
  });
});
