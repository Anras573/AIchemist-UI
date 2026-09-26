/**
 * Loopback streamable-HTTP MCP server (#223) — the single agent-tool path for
 * every attached canvas, shared by all five providers.
 *
 * Rather than adapting canvas tools per provider, this runs one HTTP server
 * bound to `127.0.0.1` on a random port, with a bearer token generated fresh
 * per app launch. Each attached canvas instance is reachable at
 * `/canvas/<canvasId>/session/<sessionId>/mcp` and injected as a managed MCP
 * server named `canvas-<slug>` — the existing HTTP-entry adapters in
 * `electron/mcp/managed.ts` (Claude, Copilot, Codex) and
 * `createManagedMcpBridge()` (Ollama, OpenAI-compatible) already handle HTTP
 * entries, so this adds no per-provider tool code.
 *
 * The server is intentionally **stateless**: every JSON-RPC request is
 * self-contained (the URL already carries canvasId + sessionId), so there is
 * no `Mcp-Session-Id` handshake to manage — each POST is handled independently
 * and answered with a plain `application/json` response. This is a conforming
 * streamable-HTTP server for the common "no server-initiated messages" case
 * (see the MCP spec's stateless-server guidance) and is exactly what the
 * `StreamableHTTPClientTransport` used by every provider's SDK expects.
 *
 * Approval is enforced HERE, not left to the provider: Claude's `PreToolUse`
 * hook passes every `mcp__*` tool through unexamined (see CLAUDE.md), so a
 * canvas tool declared `approval: "ask"` must gate itself before forwarding to
 * the host. Scoping (bad token, or a canvas not attached to the requesting
 * session) is rejected before any host is touched.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { BrowserWindow } from "electron";
import type { Database } from "better-sqlite3";

import type { Canvas } from "../../src/types/index";
import { getProjectConfig } from "../projects";
import { listProjects } from "../projects";
import { getSession } from "../sessions";
import { getAttachedCanvases, getCanvas, isCanvasAttached } from "./store";
import type { CanvasHostManager, StartCanvasHostOptions } from "./host-manager";
import { requestApproval, requiresApproval } from "../agent/approval";
import { TOOL_DENIED_MESSAGE, TOOL_DENIED_UNATTENDED_MESSAGE } from "../agent/tool-gate";
import type { McpServerEntry, McpServersMap } from "../mcp/config";

// ── Public constants ─────────────────────────────────────────────────────────

/** Surfaced to the model when a canvas's host can't be reached at all. */
export const CANVAS_UNAVAILABLE_MESSAGE = "Canvas unavailable — its host could not be started.";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB — generous for tool args, small enough to bound abuse.
const ROUTE_RE = /^\/canvas\/([^/]+)\/session\/([^/]+)\/mcp\/?$/;

// A no-op WebContents for turns with no live renderer — mirrors the pattern in
// `agent-turn-queue.ts`. `requestApproval` only ever calls `.send()` on it, and
// when `nonInteractive` is set it never even reaches that call.
const noopWebContents = { send: () => {} } as unknown as Electron.WebContents;

// ── Non-interactive turn registry ────────────────────────────────────────────
//
// The endpoint is a long-lived singleton, decoupled from any single turn's
// call stack, so it can't read a turn's `nonInteractive` flag off a local
// variable the way providers do. `electron/agent/runner.ts` calls
// `markSessionNonInteractive()` for the life of each turn so the endpoint can
// look it up by session id when a tool call arrives mid-turn.

const nonInteractiveSessions = new Set<string>();

/** Called by the turn runner at the start/end of every turn (see runner.ts). */
export function markSessionNonInteractive(sessionId: string, nonInteractive: boolean): void {
  if (nonInteractive) nonInteractiveSessions.add(sessionId);
  else nonInteractiveSessions.delete(sessionId);
}

/** Whether the turn currently running on this session (if any) is unattended. */
export function isSessionNonInteractive(sessionId: string): boolean {
  return nonInteractiveSessions.has(sessionId);
}

// ── Definition resolution (stand-in for #226's discovery tiers) ─────────────

/**
 * Resolves a canvas definition's `server.mjs` path from disk.
 *
 * This is a minimal stand-in for the full discovery tiers (project → global →
 * built-in, with manifest validation) that #226 will add — it covers the
 * project and global directories so an attached canvas's host can actually be
 * started end-to-end today, which is this issue's job ("the first issue that
 * actually starts a real host"). Returns null when no `server.mjs` is found
 * under either tier; callers surface that as "canvas unavailable" rather than
 * throwing a discovery-shaped error that doesn't exist yet.
 */
export function resolveCanvasServerPath(definition: string, projectPath: string): string | null {
  const candidates = [
    nodePath.join(projectPath, ".agents", "canvases", definition, "server.mjs"),
    nodePath.join(os.homedir(), ".aichemist", "canvases", definition, "server.mjs"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not found under this tier — try the next.
    }
  }
  return null;
}

/**
 * `getAttachedCanvases()` is called from every provider's system-prompt/MCP-map
 * builder, several of which are exercised in tests against a minimal fake `db`
 * that only stubs the calls that provider actually cares about. A DB error
 * here must never break a turn (same fail-safe stance as
 * `buildMemoryContext`/the native-transcript writers) — canvases just don't
 * show up in the prompt or tool list for that turn.
 */
function tryGetAttachedCanvases(db: Database, sessionId: string): Canvas[] {
  try {
    return getAttachedCanvases(db, sessionId);
  } catch {
    return [];
  }
}

// ── Naming / injection helpers ───────────────────────────────────────────────

/** Slugifies a canvas's title into a stable, unique-enough managed-server name. */
export function canvasServerName(canvas: Pick<Canvas, "id" | "title">): string {
  const slug =
    canvas.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "canvas";
  const shortId = canvas.id.replace(/-/g, "").slice(0, 8);
  return `canvas-${slug}-${shortId}`;
}

/** The subset of `CanvasMcpEndpoint` that server-map/context builders need. */
export interface CanvasMcpEndpointHandle {
  readonly baseUrl: string | null;
  readonly token: string;
}

/**
 * Builds the managed-MCP-server-shaped entries for a session's attached
 * canvases, ready to merge into whatever map a provider is about to hand its
 * SDK (`loadManagedMcpServers()`'s return value, or the map passed to
 * `createManagedMcpBridge()`). Empty when the endpoint hasn't started yet, or
 * the session has no canvases attached — so a provider that merges this in
 * unconditionally never has to special-case "canvas support disabled".
 */
export function canvasMcpServersForSession(
  db: Database,
  sessionId: string,
  endpoint: CanvasMcpEndpointHandle | null = getActiveCanvasMcpEndpoint()
): McpServersMap {
  if (!endpoint?.baseUrl) return {};
  const attached = tryGetAttachedCanvases(db, sessionId);
  if (attached.length === 0) return {};

  const out: McpServersMap = {};
  for (const canvas of attached) {
    const entry: McpServerEntry = {
      type: "http",
      url: `${endpoint.baseUrl}/canvas/${canvas.id}/session/${sessionId}/mcp`,
      headers: { Authorization: `Bearer ${endpoint.token}` },
    };
    out[canvasServerName(canvas)] = entry;
  }
  return out;
}

/**
 * A short system-prompt addendum (mirrors `buildMemoryContext`) listing the
 * session's attached canvases so the model knows they exist and what they're
 * for, without spending a tool call to discover them. Empty when nothing is
 * attached.
 */
export function buildCanvasSystemPromptAddendum(db: Database, sessionId: string): string {
  const attached = tryGetAttachedCanvases(db, sessionId);
  if (attached.length === 0) return "";
  const lines = attached.map((c) => `- ${c.title} (${c.definition})`).join("\n");
  return (
    "\n\nAttached canvases — full-stack work surfaces with their own agent-callable " +
    `tools (exposed as "canvas-*" MCP tools):\n${lines}`
  );
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

interface JsonRpcRequestBody {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function jsonRpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolErrorContent(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

// ── The endpoint ──────────────────────────────────────────────────────────────

/** The subset of `CanvasHostManager` the endpoint depends on (test seam). */
export type CanvasHostManagerLike = Pick<CanvasHostManager, "start" | "getStatus" | "getTools" | "callTool">;

export interface CanvasMcpEndpointOptions {
  db: Database;
  hostManager: CanvasHostManagerLike;
  getMainWindow: () => BrowserWindow | null;
}

export class CanvasMcpEndpoint {
  private readonly db: Database;
  private readonly hostManager: CanvasHostManagerLike;
  private readonly getMainWindow: () => BrowserWindow | null;
  private server: http.Server | null = null;
  private _token = "";
  private _port: number | null = null;

  constructor(options: CanvasMcpEndpointOptions) {
    this.db = options.db;
    this.hostManager = options.hostManager;
    this.getMainWindow = options.getMainWindow;
  }

  /** Per-launch bearer token. Empty string until `start()` resolves. */
  get token(): string {
    return this._token;
  }

  /** `http://127.0.0.1:<port>`, or null before `start()` resolves / after `stop()`. */
  get baseUrl(): string | null {
    return this._port !== null ? `http://127.0.0.1:${this._port}` : null;
  }

  /** Idempotent — a second `start()` while already running is a no-op. */
  async start(): Promise<void> {
    if (this.server) return;
    this._token = crypto.randomBytes(32).toString("hex");
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        console.error("[canvas-mcp-endpoint] unhandled request error:", err);
        if (!res.headersSent) sendJson(res, 500, jsonRpcError(null, -32000, "Internal error"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    const addr = server.address();
    this._port = typeof addr === "object" && addr ? addr.port : null;
  }

  /** Idempotent — stopping an already-stopped endpoint is a no-op. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this._port = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ── Request handling ────────────────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");
    const match = ROUTE_RE.exec(url.pathname);
    if (!match) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const [, canvasId, sessionId] = match;

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${this._token}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (!isCanvasAttached(this.db, sessionId, canvasId)) {
      sendJson(res, 403, { error: "canvas is not attached to this session" });
      return;
    }

    let body: JsonRpcRequestBody;
    try {
      const raw = await readBody(req, MAX_BODY_BYTES);
      body = raw ? (JSON.parse(raw) as JsonRpcRequestBody) : {};
    } catch (err) {
      sendJson(res, 400, jsonRpcError(null, -32700, err instanceof Error ? err.message : "Parse error"));
      return;
    }

    const id = body.id ?? null;
    const isNotification = body.id === undefined;
    const method = body.method ?? "";

    try {
      const result = await this.dispatch(canvasId, sessionId, method, body.params);
      if (isNotification) {
        res.writeHead(202).end();
        return;
      }
      sendJson(res, 200, jsonRpcResult(id, result));
    } catch (err) {
      if (isNotification) {
        res.writeHead(202).end();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 200, jsonRpcError(id, -32000, message));
    }
  }

  private async dispatch(canvasId: string, sessionId: string, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
        return {
          protocolVersion: requested ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "aichemist-canvas", version: "1.0.0" },
        };
      }
      case "notifications/initialized":
        return undefined;
      case "ping":
        return {};
      case "tools/list":
        return { tools: await this.listTools(canvasId, sessionId) };
      case "tools/call":
        return this.callTool(canvasId, sessionId, params as { name?: string; arguments?: Record<string, unknown> });
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private async listTools(
    canvasId: string,
    sessionId: string
  ): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
    await this.ensureHostRunning(canvasId, sessionId);
    const tools = this.hostManager.getTools(canvasId) ?? [];
    // CanvasToolDescriptor carries no JSON Schema (the host's zod schemas stay
    // in-process — see host-protocol.ts) — a permissive object schema is the
    // best we can advertise until that's threaded through.
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    }));
  }

  private async callTool(
    canvasId: string,
    sessionId: string,
    params: { name?: string; arguments?: Record<string, unknown> } | undefined
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const toolName = params?.name;
    if (!toolName) return toolErrorContent("Missing tool name");
    const args = params?.arguments ?? {};

    try {
      await this.ensureHostRunning(canvasId, sessionId);
    } catch {
      return toolErrorContent(CANVAS_UNAVAILABLE_MESSAGE);
    }

    const descriptor = this.hostManager.getTools(canvasId)?.find((t) => t.name === toolName);
    if (!descriptor) return toolErrorContent(`Unknown canvas tool "${toolName}"`);

    const gate = await this.gate(canvasId, sessionId, toolName, args, descriptor.approval);
    if (!gate.allowed) return toolErrorContent(gate.message);

    try {
      const result = await this.hostManager.callTool(canvasId, toolName, args);
      const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      console.error(`[canvas-mcp-endpoint] tool call "${toolName}" on ${canvasId} failed:`, err);
      return toolErrorContent(CANVAS_UNAVAILABLE_MESSAGE);
    }
  }

  private async ensureHostRunning(canvasId: string, sessionId: string): Promise<void> {
    if (this.hostManager.getStatus(canvasId) === "running") return;

    const canvas = getCanvas(this.db, canvasId);
    if (!canvas) throw new Error(CANVAS_UNAVAILABLE_MESSAGE);

    const session = getSession(this.db, sessionId);
    const project = listProjects(this.db).find((p) => p.id === session.project_id);
    if (!project) throw new Error(CANVAS_UNAVAILABLE_MESSAGE);

    const serverPath = resolveCanvasServerPath(canvas.definition, project.path);
    if (!serverPath) throw new Error(CANVAS_UNAVAILABLE_MESSAGE);

    const startOpts: StartCanvasHostOptions = {
      serverPath,
      projectId: project.id,
      projectPath: session.workspace_path ?? project.path,
    };
    await this.hostManager.start(canvasId, startOpts);
  }

  /**
   * Enforces the tool's declared approval policy. `"none"` tools skip the gate
   * entirely; `"ask"` tools go through the same `requiresApproval()` /
   * `requestApproval()` pipeline every other provider tool uses (see
   * approval.ts's `"canvas"` category), so a canvas tool call gets the
   * existing session/project allowlist and the unattended auto-deny for free.
   */
  private async gate(
    canvasId: string,
    sessionId: string,
    toolName: string,
    args: unknown,
    approval: "none" | "ask"
  ): Promise<{ allowed: true } | { allowed: false; message: string }> {
    if (approval === "none") return { allowed: true };

    const session = getSession(this.db, sessionId);
    const projectConfig = getProjectConfig(this.db, session.project_id);
    const fingerprintName = `canvas:${canvasId}:${toolName}`;
    if (!requiresApproval(sessionId, projectConfig, "canvas", fingerprintName, args)) {
      return { allowed: true };
    }

    const nonInteractive = isSessionNonInteractive(sessionId);
    const webContents = this.getMainWindow()?.webContents ?? noopWebContents;
    const approved = await requestApproval(webContents, sessionId, fingerprintName, args, { nonInteractive });
    if (approved) return { allowed: true };
    return { allowed: false, message: nonInteractive ? TOOL_DENIED_UNATTENDED_MESSAGE : TOOL_DENIED_MESSAGE };
  }
}

// ── App-wide singleton wiring ─────────────────────────────────────────────────
//
// Providers call `canvasMcpServersForSession(db, sessionId)` with no third
// argument, resolving against whichever endpoint `main.ts` started for this
// app run. Tests pass their own fake `CanvasMcpEndpointHandle` instead.

let activeEndpoint: CanvasMcpEndpoint | null = null;

/** Set by `main.ts` once the endpoint has started (and cleared on shutdown). */
export function setActiveCanvasMcpEndpoint(endpoint: CanvasMcpEndpoint | null): void {
  activeEndpoint = endpoint;
}

export function getActiveCanvasMcpEndpoint(): CanvasMcpEndpoint | null {
  return activeEndpoint;
}
