// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate } from "../db";
import { addProject } from "../projects";
import { createSession } from "../sessions";
import { createCanvas, setCanvasAttached } from "./store";
import { fingerprintManaged } from "../mcp/managed";
import { TOOL_DENIED_MESSAGE, TOOL_DENIED_UNATTENDED_MESSAGE } from "../agent/tool-gate";
import { resolveApproval } from "../agent/approval";
import type { CanvasToolDescriptor } from "./host-protocol";
import {
  CANVAS_UNAVAILABLE_MESSAGE,
  CanvasMcpEndpoint,
  canvasMcpServersForSession,
  canvasServerName,
  markSessionNonInteractive,
  resolveCanvasServerPath,
  buildCanvasSystemPromptAddendum,
  type CanvasHostManagerLike,
} from "./mcp-endpoint";
import type { CanvasHostStatus } from "./host-manager";

// ─── Fake host manager ───────────────────────────────────────────────────────

class FakeHostManager implements CanvasHostManagerLike {
  status: CanvasHostStatus = "running";
  tools: CanvasToolDescriptor[] = [];
  start = vi.fn(async () => {});
  callToolImpl: (tool: string, args: unknown) => unknown = () => "ok";

  getStatus(): CanvasHostStatus | undefined {
    return this.status;
  }
  getTools(): CanvasToolDescriptor[] | undefined {
    return this.tools;
  }
  async callTool(_canvasId: string, tool: string, args: unknown): Promise<unknown> {
    const result = this.callToolImpl(tool, args);
    if (result instanceof Error) throw result;
    return result;
  }
}

// ─── Test scaffolding ────────────────────────────────────────────────────────

let db: Database.Database;
let projectPath: string;
let projectId: string;
let sessionId: string;
let canvasId: string;
let hostManager: FakeHostManager;
let endpoint: CanvasMcpEndpoint;
let webContentsSend: ReturnType<typeof vi.fn>;
let getMainWindow: () => { webContents: { send: ReturnType<typeof vi.fn> } } | null;

beforeEach(async () => {
  db = new Database(":memory:");
  migrate(db);

  projectPath = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-mcp-test-"));
  const project = addProject(db, projectPath);
  projectId = project.id;

  const session = createSession(db, projectId, "anthropic");
  sessionId = session.id;

  const canvas = createCanvas(db, { projectId, definition: "kanban", title: "Release board" });
  canvasId = canvas.id;
  setCanvasAttached(db, sessionId, canvasId, true);

  hostManager = new FakeHostManager();
  webContentsSend = vi.fn();
  getMainWindow = () => ({ webContents: { send: webContentsSend } });

  endpoint = new CanvasMcpEndpoint({
    db,
    hostManager: hostManager as unknown as CanvasHostManagerLike,
    getMainWindow: getMainWindow as never,
  });
  await endpoint.start();
});

afterEach(async () => {
  await endpoint.stop();
  db.close();
  fs.rmSync(projectPath, { recursive: true, force: true });
  markSessionNonInteractive(sessionId, false);
});

function url(path: string): string {
  return `${endpoint.baseUrl}${path}`;
}

function routePath(cid: string, sid: string): string {
  return `/canvas/${cid}/session/${sid}/mcp`;
}

async function rpc(path: string, body: Record<string, unknown>, headers?: Record<string, string>) {
  const res = await fetch(url(path), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}`, ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

describe("authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await fetch(url(routePath(canvasId, sessionId)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request with a wrong bearer token", async () => {
    const res = await rpc(routePath(canvasId, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      authorization: "Bearer not-the-token",
    });
    expect(res.status).toBe(401);
  });

  it("accepts a request with the correct bearer token", async () => {
    const res = await rpc(routePath(canvasId, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
  });
});

// ─── Scoping ─────────────────────────────────────────────────────────────────

describe("scoping", () => {
  it("rejects a canvas that is not attached to the session", async () => {
    const other = createCanvas(db, { projectId, definition: "kanban", title: "Other board" });
    const res = await rpc(routePath(other.id, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
  });

  it("rejects an unknown canvas id", async () => {
    const res = await rpc(routePath("nonexistent", sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
  });

  it("404s a path that doesn't match the route shape", async () => {
    const res = await rpc("/not/a/canvas/route", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(404);
  });
});

// ─── tools/list forwarding ───────────────────────────────────────────────────

describe("tools/list", () => {
  it("forwards the host's declared tools, starting the host if not running", async () => {
    const dir = nodePath.join(projectPath, ".agents", "canvases", "kanban");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "server.mjs"), "export default {};");

    hostManager.status = "starting";
    hostManager.start = vi.fn(async () => {
      hostManager.status = "running";
    });
    hostManager.tools = [
      { name: "get_board", description: "Return the board", approval: "none" },
      { name: "move_card", description: "Move a card", approval: "ask" },
    ];

    const res = await rpc(routePath(canvasId, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };

    expect(hostManager.start).toHaveBeenCalledOnce();
    expect(body.result.tools.map((t) => t.name)).toEqual(["get_board", "move_card"]);
    expect(body.result.tools[0]).toHaveProperty("inputSchema");
  });

  it("does not restart an already-running host", async () => {
    hostManager.status = "running";
    await rpc(routePath(canvasId, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(hostManager.start).not.toHaveBeenCalled();
  });
});

// ─── tools/call — approval gate ──────────────────────────────────────────────

describe("tools/call approval gate", () => {
  it('calls a "none"-approval tool immediately, no approval prompt', async () => {
    hostManager.tools = [{ name: "get_board", description: "Return the board", approval: "none" }];
    hostManager.callToolImpl = () => "the board";

    const res = await rpc(routePath(canvasId, sessionId), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_board", arguments: {} },
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };

    expect(webContentsSend).not.toHaveBeenCalled();
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toBe("the board");
  });

  it('gates an "ask"-approval tool behind requestApproval and forwards on approve', async () => {
    hostManager.tools = [{ name: "move_card", description: "Move a card", approval: "ask" }];
    hostManager.callToolImpl = () => "moved";

    const resultPromise = rpc(routePath(canvasId, sessionId), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "move_card", arguments: { id: "1", to: "done" } },
    });

    await vi.waitFor(() => expect(webContentsSend).toHaveBeenCalledOnce());
    const [channel, payload] = webContentsSend.mock.calls[0] as [string, { approval_id: string }];
    expect(channel).toBe("session:approval_required");
    resolveApproval(payload.approval_id, true);

    const res = await resultPromise;
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toBe("moved");
  });

  it('denies an "ask"-approval tool when the user rejects, without calling the host', async () => {
    hostManager.tools = [{ name: "move_card", description: "Move a card", approval: "ask" }];
    const callToolSpy = vi.spyOn(hostManager, "callTool");

    const resultPromise = rpc(routePath(canvasId, sessionId), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "move_card", arguments: {} },
    });

    await vi.waitFor(() => expect(webContentsSend).toHaveBeenCalledOnce());
    const [, payload] = webContentsSend.mock.calls[0] as [string, { approval_id: string }];
    resolveApproval(payload.approval_id, false);

    const res = await resultPromise;
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(TOOL_DENIED_MESSAGE);
    expect(callToolSpy).not.toHaveBeenCalled();
  });

  it('auto-denies an "ask"-approval tool without prompting when the session is marked non-interactive', async () => {
    hostManager.tools = [{ name: "move_card", description: "Move a card", approval: "ask" }];
    markSessionNonInteractive(sessionId, true);

    const res = await rpc(routePath(canvasId, sessionId), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "move_card", arguments: {} },
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };

    expect(webContentsSend).not.toHaveBeenCalled();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(TOOL_DENIED_UNATTENDED_MESSAGE);
  });

  it("errors for an unknown tool name without touching the host", async () => {
    hostManager.tools = [{ name: "get_board", description: "Return the board", approval: "none" }];
    const callToolSpy = vi.spyOn(hostManager, "callTool");

    const res = await rpc(routePath(canvasId, sessionId), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "not_a_real_tool", arguments: {} },
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(callToolSpy).not.toHaveBeenCalled();
  });
});

// ─── Host unavailable / timeouts ─────────────────────────────────────────────

describe("host unavailable", () => {
  it("returns a clear error when the host fails to start (no definition on disk)", async () => {
    hostManager.status = "stopped";
    // No .agents/canvases/kanban/server.mjs was ever created under projectPath,
    // so resolveCanvasServerPath() returns null and ensureHostRunning() throws
    // before ever calling hostManager.start().
    const res = await rpc(routePath(canvasId, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toBe(CANVAS_UNAVAILABLE_MESSAGE);
  });

  it("returns a clear error (not a hang) when the host call rejects", async () => {
    hostManager.tools = [{ name: "get_board", description: "Return the board", approval: "none" }];
    hostManager.callToolImpl = () => new Error("Canvas host did not reply within 60000ms");

    const res = await rpc(routePath(canvasId, sessionId), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_board", arguments: {} },
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(CANVAS_UNAVAILABLE_MESSAGE);
  });
});

// ─── Protocol basics ─────────────────────────────────────────────────────────

describe("protocol basics", () => {
  it("responds to initialize with a protocol version and capabilities", async () => {
    const res = await rpc(routePath(canvasId, sessionId), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const body = (await res.json()) as { result: { protocolVersion: string; capabilities: { tools: object } } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toEqual({});
  });

  it("responds 202 with no body to a notification (no id)", async () => {
    const res = await rpc(routePath(canvasId, sessionId), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
  });

  it("rejects a GET request", async () => {
    const res = await fetch(url(routePath(canvasId, sessionId)), {
      headers: { authorization: `Bearer ${endpoint.token}` },
    });
    expect(res.status).toBe(405);
  });
});

// ─── canvasMcpServersForSession / canvasServerName ───────────────────────────

describe("canvasMcpServersForSession", () => {
  it("returns an empty map when the endpoint hasn't started", () => {
    const map = canvasMcpServersForSession(db, sessionId, { baseUrl: null, token: "x" });
    expect(map).toEqual({});
  });

  it("returns an empty map when the session has no attached canvases", () => {
    setCanvasAttached(db, sessionId, canvasId, false);
    const map = canvasMcpServersForSession(db, sessionId, endpoint);
    expect(map).toEqual({});
  });

  it("builds an HTTP entry per attached canvas, scoped to canvas + session", () => {
    const map = canvasMcpServersForSession(db, sessionId, endpoint);
    const name = canvasServerName({ id: canvasId, title: "Release board" });
    expect(Object.keys(map)).toEqual([name]);
    expect(map[name]).toMatchObject({
      type: "http",
      url: `${endpoint.baseUrl}/canvas/${canvasId}/session/${sessionId}/mcp`,
      headers: { Authorization: `Bearer ${endpoint.token}` },
    });
  });

  it("only includes canvases attached to the given session, not every canvas in the project", () => {
    createCanvas(db, { projectId, definition: "kanban", title: "Unattached board" });
    const map = canvasMcpServersForSession(db, sessionId, endpoint);
    expect(Object.keys(map)).toHaveLength(1);
  });
});

describe("canvasServerName", () => {
  it("slugifies the title and appends a short id suffix for uniqueness", () => {
    const name = canvasServerName({ id: "abcd1234-ef56-0000-0000-000000000000", title: "My Board!!" });
    expect(name).toMatch(/^canvas-my-board-[a-f0-9]{8}$/);
  });

  it("produces distinct names for two canvases sharing a title", () => {
    const a = canvasServerName({ id: "11111111-1111-1111-1111-111111111111", title: "Board" });
    const b = canvasServerName({ id: "22222222-2222-2222-2222-222222222222", title: "Board" });
    expect(a).not.toBe(b);
  });
});

describe("buildCanvasSystemPromptAddendum", () => {
  it("lists attached canvases by title and definition", () => {
    const addendum = buildCanvasSystemPromptAddendum(db, sessionId);
    expect(addendum).toContain("Release board");
    expect(addendum).toContain("kanban");
  });

  it("is empty when nothing is attached", () => {
    setCanvasAttached(db, sessionId, canvasId, false);
    expect(buildCanvasSystemPromptAddendum(db, sessionId)).toBe("");
  });
});

describe("Copilot mcpFp invalidation on attach/detach (#223)", () => {
  // copilot.ts merges canvasMcpServersForSession() into managedMcpRaw BEFORE
  // calling fingerprintManaged() — this proves that merge is enough on its
  // own to change the fingerprint on attach/detach, with no separate
  // canvas-specific fingerprint logic needed (see copilot.ts's comment at the
  // managedMcpRaw computation).
  it("changes the fingerprint when a canvas is attached, and reverts when detached", () => {
    const baseline = fingerprintManaged(canvasMcpServersForSession(db, sessionId, { baseUrl: null, token: "x" }));

    setCanvasAttached(db, sessionId, canvasId, false);
    const detachedFp = fingerprintManaged(canvasMcpServersForSession(db, sessionId, endpoint));
    expect(detachedFp).toBe(baseline);

    setCanvasAttached(db, sessionId, canvasId, true);
    const attachedFp = fingerprintManaged(canvasMcpServersForSession(db, sessionId, endpoint));
    expect(attachedFp).not.toBe(baseline);

    setCanvasAttached(db, sessionId, canvasId, false);
    const redetachedFp = fingerprintManaged(canvasMcpServersForSession(db, sessionId, endpoint));
    expect(redetachedFp).toBe(baseline);
  });
});

describe("resolveCanvasServerPath", () => {
  it("finds a project-tier definition's server.mjs", () => {
    const dir = nodePath.join(projectPath, ".agents", "canvases", "kanban");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "server.mjs"), "export default {};");

    expect(resolveCanvasServerPath("kanban", projectPath)).toBe(nodePath.join(dir, "server.mjs"));
  });

  it("returns null when no definition is found under either tier", () => {
    expect(resolveCanvasServerPath("does-not-exist", projectPath)).toBeNull();
  });
});
