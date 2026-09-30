// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate } from "../db";
import { addProject, getProjectConfig, saveProjectConfig } from "../projects";
import { createSession } from "../sessions";
import { createCanvas, isCanvasAttached, setCanvasAttached } from "./store";
import { fingerprintManaged } from "../mcp/managed";
import { TOOL_DENIED_MESSAGE, TOOL_DENIED_UNATTENDED_MESSAGE } from "../agent/tool-gate";
import { addToSessionAllowlist, resolveApproval } from "../agent/approval";
import type { CanvasToolDescriptor } from "./host-protocol";
import {
  CANVAS_UNAVAILABLE_MESSAGE,
  CanvasMcpEndpoint,
  canvasMcpServersForSession,
  CANVAS_MANAGER_SERVER_NAME,
  canvasServerName,
  markSessionNonInteractive,
  resolveCanvasServerPath,
  buildCanvasSystemPromptAddendum,
  _setCanvasesRootForTests,
  type CanvasHostManagerLike,
} from "./mcp-endpoint";
import { CanvasToolError, type CanvasHostStatus } from "./host-manager";
import { trustProjectCanvas } from "./trust";

// ─── Fake host manager ───────────────────────────────────────────────────────

class FakeHostManager implements CanvasHostManagerLike {
  status: CanvasHostStatus = "running";
  tools: CanvasToolDescriptor[] = [];
  start = vi.fn(async () => {});
  setTurnActive = vi.fn((_canvasId: string, _active: boolean) => {});
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
/** webContents.send calls other than the Canvas-tab `focus` / `list` pushes (#229). */
const nonFocusSends = () =>
  webContentsSend.mock.calls.filter(([channel, payload]) => !(channel === "canvas:event" && ["focus", "list"].includes((payload as { kind?: string })?.kind ?? "")));
let getMainWindow: () => { webContents: { send: ReturnType<typeof vi.fn> } } | null;
let canvasesRoot: string;

beforeEach(async () => {
  db = new Database(":memory:");
  migrate(db);

  projectPath = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-mcp-test-"));
  canvasesRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-mcp-global-"));
  _setCanvasesRootForTests(canvasesRoot);
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
  fs.rmSync(canvasesRoot, { recursive: true, force: true });
  _setCanvasesRootForTests(null);
  markSessionNonInteractive(sessionId, false);
});

/** Drops the always-present canvas manager entry so assertions can focus on per-canvas servers. */
const canvasOnly = (map: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(map).filter(([name]) => name !== CANVAS_MANAGER_SERVER_NAME));

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
    const dir = nodePath.join(canvasesRoot, "kanban");
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

  it("advertises the host's real inputSchema (#223) so the model knows a tool's arguments", async () => {
    hostManager.tools = [
      {
        name: "move_card",
        description: "Move a card",
        approval: "ask",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    ];
    const res = await rpc(routePath(canvasId, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: Array<{ inputSchema: unknown }> } };
    expect(body.result.tools[0].inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
  });

  it("falls back to a permissive inputSchema when the host's descriptor has none", async () => {
    hostManager.tools = [{ name: "get_board", description: "Return the board", approval: "none" }];
    const res = await rpc(routePath(canvasId, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: Array<{ inputSchema: unknown }> } };
    expect(body.result.tools[0].inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: true });
  });
});

// ─── tools/call — approval gate ──────────────────────────────────────────────

describe("tools/call approval gate", () => {
  it("pushes a focus event so the renderer can surface the Canvas tab", async () => {
    hostManager.tools = [{ name: "get_board", description: "Return the board", approval: "none" }];
    hostManager.callToolImpl = () => "the board";
    await rpc(routePath(canvasId, sessionId), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_board", arguments: {} },
    });
    expect(webContentsSend).toHaveBeenCalledWith("canvas:event", { canvasId, kind: "focus", sessionId });
  });

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

    expect(nonFocusSends()).toEqual([]);
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

    await vi.waitFor(() => expect(nonFocusSends()).toHaveLength(1));
    const [channel, payload] = nonFocusSends()[0] as [string, { approval_id: string }];
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

    await vi.waitFor(() => expect(nonFocusSends()).toHaveLength(1));
    const [, payload] = nonFocusSends()[0] as [string, { approval_id: string }];
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

    expect(nonFocusSends()).toEqual([]);
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
    // A definition name that isn't the built-in kanban tier and has no
    // <canvasesRoot>/<name>/server.mjs either, so resolveCanvasServerPath()
    // returns null and ensureHostRunning() throws before ever calling
    // hostManager.start().
    const missing = createCanvas(db, { projectId, definition: "no-such-definition", title: "Missing" });
    setCanvasAttached(db, sessionId, missing.id, true);

    const res = await rpc(routePath(missing.id, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
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

  it("surfaces the tool's own error message instead of 'canvas unavailable' when the host is fine but the tool itself failed", async () => {
    hostManager.tools = [{ name: "move_card", description: "Move a card", approval: "none" }];
    hostManager.callToolImpl = () => new CanvasToolError('Invalid input for tool "move_card": card not found');

    const res = await rpc(routePath(canvasId, sessionId), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "move_card", arguments: { id: "missing" } },
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe('Invalid input for tool "move_card": card not found');
    expect(body.result.content[0].text).not.toBe(CANVAS_UNAVAILABLE_MESSAGE);
  });
});

// ─── Project-tier trust gating (#227) ────────────────────────────────────────

describe("project-tier trust gating (#227)", () => {
  function writeProjectDefinition(name: string, serverBody = "export default {};"): string {
    const dir = nodePath.join(projectPath, ".agents", "canvases", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      nodePath.join(dir, "canvas.json"),
      JSON.stringify({ name, description: "", version: 1, server: "server.mjs", ui: "ui/index.html" })
    );
    fs.writeFileSync(nodePath.join(dir, "server.mjs"), serverBody);
    return dir;
  }

  it("refuses to start a host / expose tools for an untrusted project canvas", async () => {
    hostManager.status = "stopped"; // FakeHostManager.getStatus() ignores canvasId — start with no host "running"
    writeProjectDefinition("widgets");
    const canvas = createCanvas(db, { projectId, definition: "widgets", title: "Widgets" });
    setCanvasAttached(db, sessionId, canvas.id, true);

    const res = await rpc(routePath(canvas.id, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toBe(CANVAS_UNAVAILABLE_MESSAGE);
    expect(hostManager.start).not.toHaveBeenCalled();
  });

  it("starts the host and exposes tools once the definition is trusted", async () => {
    hostManager.status = "stopped";
    writeProjectDefinition("widgets");
    const canvas = createCanvas(db, { projectId, definition: "widgets", title: "Widgets" });
    setCanvasAttached(db, sessionId, canvas.id, true);

    trustProjectCanvas(db, projectId, projectPath, "widgets");

    const res = await rpc(routePath(canvas.id, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toEqual([]);
    expect(hostManager.start).toHaveBeenCalledTimes(1);
  });

  it("re-locks (untrusts) once a hashed file changes after trust", async () => {
    hostManager.status = "stopped";
    writeProjectDefinition("widgets");
    const canvas = createCanvas(db, { projectId, definition: "widgets", title: "Widgets" });
    setCanvasAttached(db, sessionId, canvas.id, true);

    trustProjectCanvas(db, projectId, projectPath, "widgets");

    // Edit the server entry after trust was granted — the stored content
    // hash no longer matches, so it must re-prompt (refuse) rather than keep
    // running the edited code under the old consent.
    writeProjectDefinition("widgets", "export default { edited: true };");

    const res = await rpc(routePath(canvas.id, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toBe(CANVAS_UNAVAILABLE_MESSAGE);
  });

  it("canvasMcpServersForSession excludes an untrusted project canvas and includes it once trusted", async () => {
    writeProjectDefinition("widgets");
    const canvas = createCanvas(db, { projectId, definition: "widgets", title: "Widgets" });
    setCanvasAttached(db, sessionId, canvas.id, true);

    const before = canvasMcpServersForSession(db, sessionId, { baseUrl: endpoint.baseUrl, token: endpoint.token });
    expect(Object.keys(canvasOnly(before))).toEqual([canvasServerName({ id: canvasId, title: "Release board" })]);

    trustProjectCanvas(db, projectId, projectPath, "widgets");

    const after = canvasMcpServersForSession(db, sessionId, { baseUrl: endpoint.baseUrl, token: endpoint.token });
    expect(Object.keys(canvasOnly(after)).sort()).toEqual(
      [canvasServerName({ id: canvasId, title: "Release board" }), canvasServerName({ id: canvas.id, title: "Widgets" })].sort()
    );
  });

  it("buildCanvasSystemPromptAddendum omits an untrusted project canvas", () => {
    writeProjectDefinition("widgets");
    const canvas = createCanvas(db, { projectId, definition: "widgets", title: "Widgets" });
    setCanvasAttached(db, sessionId, canvas.id, true);

    const addendum = buildCanvasSystemPromptAddendum(db, sessionId);
    expect(addendum).toContain("Release board");
    expect(addendum).not.toContain("Widgets");
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

  it("returns only the manager entry when the session has no attached canvases", () => {
    setCanvasAttached(db, sessionId, canvasId, false);
    const map = canvasMcpServersForSession(db, sessionId, endpoint);
    expect(Object.keys(map)).toEqual([CANVAS_MANAGER_SERVER_NAME]);
    expect(map[CANVAS_MANAGER_SERVER_NAME]).toMatchObject({
      type: "http",
      url: `${endpoint.baseUrl}/session/${sessionId}/canvas-manager/mcp`,
    });
  });

  it("builds an HTTP entry per attached canvas, scoped to canvas + session", () => {
    const map = canvasMcpServersForSession(db, sessionId, endpoint);
    const name = canvasServerName({ id: canvasId, title: "Release board" });
    expect(Object.keys(canvasOnly(map))).toEqual([name]);
    expect(map[name]).toMatchObject({
      type: "http",
      url: `${endpoint.baseUrl}/canvas/${canvasId}/session/${sessionId}/mcp`,
      headers: { Authorization: `Bearer ${endpoint.token}` },
    });
  });

  it("only includes canvases attached to the given session, not every canvas in the project", () => {
    createCanvas(db, { projectId, definition: "kanban", title: "Unattached board" });
    const map = canvasMcpServersForSession(db, sessionId, endpoint);
    expect(Object.keys(canvasOnly(map))).toHaveLength(1);
  });

  it("excludes a canvas whose definition no longer resolves (\"definition missing\", #226 follow-up)", () => {
    const missing = createCanvas(db, { projectId, definition: "does-not-exist-on-disk", title: "Orphaned" });
    setCanvasAttached(db, sessionId, missing.id, true);

    const map = canvasMcpServersForSession(db, sessionId, endpoint);

    const missingName = canvasServerName({ id: missing.id, title: "Orphaned" });
    expect(map[missingName]).toBeUndefined();
    // The still-resolvable "kanban" canvas from beforeEach is unaffected.
    expect(Object.keys(canvasOnly(map))).toHaveLength(1);
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

  it("always carries the create-canvas awareness note, pointing at a real guide file", () => {
    setCanvasAttached(db, sessionId, canvasId, false);
    const addendum = buildCanvasSystemPromptAddendum(db, sessionId);
    expect(addendum).toContain("create-canvas");
    const guidePath = /read the guide at (\S+)/.exec(addendum)?.[1];
    expect(guidePath && fs.existsSync(guidePath)).toBe(true);
    expect(addendum).not.toContain("Attached canvases");
  });

  it("excludes a canvas whose definition no longer resolves", () => {
    const missing = createCanvas(db, { projectId, definition: "does-not-exist-on-disk", title: "Orphaned" });
    setCanvasAttached(db, sessionId, missing.id, true);
    setCanvasAttached(db, sessionId, canvasId, false); // isolate to just the orphaned one

    expect(buildCanvasSystemPromptAddendum(db, sessionId)).not.toContain("Attached canvases");
  });

  it("is empty when nothing is attached", () => {
    setCanvasAttached(db, sessionId, canvasId, false);
    expect(buildCanvasSystemPromptAddendum(db, sessionId)).not.toContain("Attached canvases");
  });
});

describe("setTurnActive", () => {
  it("forwards to the host manager for every canvas attached to the session", () => {
    const other = createCanvas(db, { projectId, definition: "kanban", title: "Other board" });
    setCanvasAttached(db, sessionId, other.id, true);

    endpoint.setTurnActive(sessionId, true);
    expect(hostManager.setTurnActive).toHaveBeenCalledWith(canvasId, true);
    expect(hostManager.setTurnActive).toHaveBeenCalledWith(other.id, true);

    hostManager.setTurnActive.mockClear();
    endpoint.setTurnActive(sessionId, false);
    expect(hostManager.setTurnActive).toHaveBeenCalledWith(canvasId, false);
    expect(hostManager.setTurnActive).toHaveBeenCalledWith(other.id, false);
  });

  it("is a no-op for a session with nothing attached", () => {
    setCanvasAttached(db, sessionId, canvasId, false);
    expect(() => endpoint.setTurnActive(sessionId, true)).not.toThrow();
    expect(hostManager.setTurnActive).not.toHaveBeenCalled();
  });

  it("applies to a host started lazily mid-turn — the common case: no host record yet when the turn starts (#223 follow-up review)", async () => {
    const dir = nodePath.join(canvasesRoot, "kanban");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "server.mjs"), "export default {};");

    // No host record exists yet for this canvas — mirrors a session's first
    // turn, or one after an idle stop.
    hostManager.status = "stopped";
    hostManager.start = vi.fn(async () => {
      hostManager.status = "running";
    });

    // runner.ts calls this at turn start, BEFORE the first tool call ever
    // starts the host. It forwards to the manager unconditionally (asserted
    // above), so clear that call and prove ensureHostRunning re-applies it
    // once the host actually exists.
    endpoint.setTurnActive(sessionId, true);
    hostManager.setTurnActive.mockClear();

    await rpc(routePath(canvasId, sessionId), { jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(hostManager.start).toHaveBeenCalledOnce();
    expect(hostManager.setTurnActive).toHaveBeenCalledWith(canvasId, true);
  });
});

describe("Copilot mcpFp invalidation on attach/detach (#223)", () => {
  // copilot.ts merges canvasMcpServersForSession() into managedMcpRaw BEFORE
  // calling fingerprintManaged() — this proves that merge is enough on its
  // own to change the fingerprint on attach/detach, with no separate
  // canvas-specific fingerprint logic needed (see copilot.ts's comment at the
  // managedMcpRaw computation).
  it("changes the fingerprint when a canvas is attached, and reverts when detached", () => {
    const baseline = fingerprintManaged(canvasOnly(canvasMcpServersForSession(db, sessionId, { baseUrl: null, token: "x" })) as never);

    setCanvasAttached(db, sessionId, canvasId, false);
    const detachedFp = fingerprintManaged(canvasOnly(canvasMcpServersForSession(db, sessionId, endpoint)) as never);
    expect(detachedFp).toBe(baseline);

    setCanvasAttached(db, sessionId, canvasId, true);
    const attachedFp = fingerprintManaged(canvasOnly(canvasMcpServersForSession(db, sessionId, endpoint)) as never);
    expect(attachedFp).not.toBe(baseline);

    setCanvasAttached(db, sessionId, canvasId, false);
    const redetachedFp = fingerprintManaged(canvasOnly(canvasMcpServersForSession(db, sessionId, endpoint)) as never);
    expect(redetachedFp).toBe(baseline);
  });
});

describe("resolveCanvasServerPath", () => {
  it("finds a global-tier definition's server.mjs", () => {
    const dir = nodePath.join(canvasesRoot, "kanban");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "server.mjs"), "export default {};");

    expect(resolveCanvasServerPath("kanban")).toBe(nodePath.join(dir, "server.mjs"));
  });

  it("does NOT resolve a project-tier definition (untrusted until #227's trust prompt lands)", () => {
    // Not "kanban" — that name now has a trusted built-in fallback (#225),
    // which would mask the project-tier miss this test is actually about.
    const dir = nodePath.join(projectPath, ".agents", "canvases", "widgets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "server.mjs"), "export default {};");

    expect(resolveCanvasServerPath("widgets")).toBeNull();
  });

  it("returns null when no definition is found", () => {
    expect(resolveCanvasServerPath("does-not-exist")).toBeNull();
  });

  it("rejects a definition name that attempts path traversal", () => {
    // A malicious canvas row could try to escape canvasesRoot via `definition`.
    // These alone don't prove the guard does anything — none resolves to a
    // real file even without it (statSync just misses). The next test proves
    // the guard actually blocks a real escape.
    expect(resolveCanvasServerPath("..")).toBeNull();
    expect(resolveCanvasServerPath("a/../../b")).toBeNull();
    expect(resolveCanvasServerPath("a/b")).toBeNull();
    expect(resolveCanvasServerPath("a\\b")).toBeNull();
  });

  it("rejects a traversal definition that WOULD resolve to a real server.mjs outside canvasesRoot without the guard", () => {
    // Place server.mjs at the traversal target itself, one level above
    // canvasesRoot, so a definition that escaped the guard would genuinely
    // find and return it — not just miss on a nonexistent path.
    const outside = nodePath.join(nodePath.dirname(canvasesRoot), `canvas-mcp-evil-${Date.now()}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(nodePath.join(outside, "server.mjs"), "export default {};");
    try {
      const definition = nodePath.relative(canvasesRoot, outside);
      expect(definition).toContain(".."); // sanity: this really is a traversal
      // Without isSafeDefinitionName()/the resolved-path prefix check, this
      // would resolve to `nodePath.join(outside, "server.mjs")` — a real file.
      expect(resolveCanvasServerPath(definition)).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ─── create_canvas_instance (agent-callable, approval-gated, #229) ───────────

describe("canvas manager server — create_canvas_instance", () => {
  const managerPath = () => `/session/${sessionId}/canvas-manager/mcp`;
  const callCreate = (args: Record<string, unknown>) =>
    rpc(managerPath(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_canvas_instance", arguments: args } });
  const instances = () => db.prepare("SELECT * FROM canvases WHERE title = ?");

  it("rejects a request without the bearer token", async () => {
    const res = await fetch(url(managerPath()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("lists exactly the create_canvas_instance tool", async () => {
    const res = await rpc(managerPath(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(["create_canvas_instance"]);
  });

  it("on approval, creates the instance, attaches it to the session, and pushes list + focus events", async () => {
    const pending = callCreate({ definition: "checklist", title: "Launch list" });

    await vi.waitFor(() => expect(nonFocusSends()).toHaveLength(1));
    const [channel, payload] = nonFocusSends()[0] as [string, { approval_id: string }];
    expect(channel).toBe("session:approval_required");
    resolveApproval(payload.approval_id, true);

    const body = (await (await pending).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toMatch(/next turn/);

    const created = instances().get("Launch list") as { id: string; definition: string; project_id: string };
    expect(created).toMatchObject({ definition: "checklist", project_id: projectId });
    expect(isCanvasAttached(db, sessionId, created.id)).toBe(true);
    expect(webContentsSend).toHaveBeenCalledWith("canvas:event", { canvasId: created.id, kind: "list", sessionId });
    expect(webContentsSend).toHaveBeenCalledWith("canvas:event", { canvasId: created.id, kind: "focus", sessionId });
  });

  it("still prompts after a session allowlist entry for it exists (never auto-approved)", async () => {
    const args = { definition: "checklist", title: "Sneaky" };
    for (const name of ["canvas:create_canvas_instance", "create_canvas_instance"]) addToSessionAllowlist(sessionId, name, args);

    const pending = callCreate(args);
    await vi.waitFor(() => expect(nonFocusSends()).toHaveLength(1));
    expect(nonFocusSends()[0][0]).toBe("session:approval_required");
    expect(instances().get("Sneaky")).toBeUndefined(); // nothing created before the user answers
    resolveApproval((nonFocusSends()[0][1] as { approval_id: string }).approval_id, false);
    await pending;
    expect(instances().get("Sneaky")).toBeUndefined();
  });

  it("still prompts after a project allowed_tools entry for it exists", async () => {
    const config = getProjectConfig(db, projectId);
    saveProjectConfig(db, projectId, {
      ...config,
      allowed_tools: [
        ...(config.allowed_tools ?? []),
        { tool_name: "canvas:create_canvas_instance" },
        { tool_name: "create_canvas_instance" },
      ],
    });

    const pending = callCreate({ definition: "checklist", title: "Sneaky 2" });
    await vi.waitFor(() => expect(nonFocusSends()).toHaveLength(1));
    resolveApproval((nonFocusSends()[0][1] as { approval_id: string }).approval_id, false);
    await pending;
    expect(instances().get("Sneaky 2")).toBeUndefined();
  });

  it("auto-denies without prompting on an unattended turn, even with an allowlist entry", async () => {
    addToSessionAllowlist(sessionId, "canvas:create_canvas_instance", {});
    markSessionNonInteractive(sessionId, true);

    const body = (await (await callCreate({ definition: "checklist", title: "Unattended" })).json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(TOOL_DENIED_UNATTENDED_MESSAGE);
    expect(nonFocusSends()).toEqual([]);
    expect(instances().get("Unattended")).toBeUndefined();
  });

  it("creates nothing when the user denies", async () => {
    const pending = callCreate({ definition: "checklist", title: "Denied list" });
    await vi.waitFor(() => expect(nonFocusSends()).toHaveLength(1));
    resolveApproval((nonFocusSends()[0][1] as { approval_id: string }).approval_id, false);

    const body = (await (await pending).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(TOOL_DENIED_MESSAGE);
    expect(instances().get("Denied list")).toBeUndefined();
  });

  it("errors (without prompting) for an unknown definition, listing what exists", async () => {
    const body = (await (await callCreate({ definition: "nope", title: "X" })).json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/No canvas definition named "nope"[\s\S]*kanban/);
    expect(nonFocusSends()).toEqual([]);
  });

  it("requires both definition and title", async () => {
    const body = (await (await callCreate({ definition: "kanban" })).json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
  });

  it("can instantiate a project-tier definition and warns that it needs the trust prompt", async () => {
    const dir = nodePath.join(projectPath, ".agents", "canvases", "widgets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      nodePath.join(dir, "canvas.json"),
      JSON.stringify({ name: "widgets", description: "", version: 1, server: "server.mjs", ui: "ui/index.html" })
    );
    fs.writeFileSync(nodePath.join(dir, "server.mjs"), "export default {};");
    const pending = callCreate({ definition: "widgets", title: "Widgets" });
    await vi.waitFor(() => expect(nonFocusSends()).toHaveLength(1));
    resolveApproval((nonFocusSends()[0][1] as { approval_id: string }).approval_id, true);

    const body = (await (await pending).json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0].text).toMatch(/Trust and run/);
  });
});
