/**
 * `aichemist-canvas://<canvasId>/<path>` protocol (#224) — serves a canvas
 * instance's UI to the sandboxed `<iframe>` in `CanvasFrame`
 * (`src/components/session/CanvasFrame.tsx`). The UI must stay inert: no
 * access to the host DOM, storage, or `window.electronAPI`, and no network —
 * enforced here (CSP + no `allow-same-origin` on the iframe, set by
 * `CanvasFrame`) and at the protocol boundary (only files under the resolved
 * definition's `ui/` folder are ever served).
 *
 * `registerCanvasProtocolScheme()` must run before `app.whenReady()` (Electron
 * requires privileged-scheme registration before the app is ready);
 * `registerCanvasProtocol(db)` wires the actual request handler and is called
 * from `whenReady()` once the DB is open, same as the rest of main.ts's
 * startup.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { protocol } from "electron";
import type { Database } from "better-sqlite3";
import { getCanvas } from "./store";
import { resolveCanvasUiDir } from "./definitions";
import { CANVAS_CLIENT_SCRIPT_SOURCE } from "./client-script";

/** The scheme every canvas UI is served from. */
export const CANVAS_PROTOCOL_SCHEME = "aichemist-canvas";

/** Served for every canvas at this fixed path, independent of its `ui/` folder contents. */
export const CANVAS_CLIENT_SCRIPT_PATH = "/aichemist-canvas-client.js";

/**
 * CSP applied to every response this protocol returns (success or error): the
 * UI may load scripts/styles/images only from this scheme (`default-src`,
 * plus `'unsafe-inline'` since canvas authors write plain `<script>`/`<style>`
 * tags with no build step), and it has no network at all (`connect-src
 * 'none'`) — anything network- or system-bound goes through the canvas's
 * server, where trust applies.
 */
function cspHeader(): string {
  return `default-src ${CANVAS_PROTOCOL_SCHEME}: 'unsafe-inline'; connect-src 'none'`;
}

function baseHeaders(contentType: string): Record<string, string> {
  return { "content-type": contentType, "content-security-policy": cspHeader() };
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: baseHeaders("text/plain; charset=utf-8") });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[nodePath.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Must be called before `app.whenReady()` — Electron requires privileged
 * schemes to be registered before the app is ready. `standard: true` gives
 * the scheme normal hierarchical URL parsing (so a UI's relative
 * `<script src="app.js">` resolves against `aichemist-canvas://<id>/index.html`
 * the way it would under http/https); `secure: true` marks it a secure
 * context. Fetch support and CORS are deliberately left off — the UI has no
 * network per the CSP below regardless, so there's no reason to widen this.
 */
export function registerCanvasProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CANVAS_PROTOCOL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
    },
  ]);
}

/** Resolves the request path against a definition's `ui/` folder, refusing traversal. */
async function resolveUiFile(uiDir: string, pathname: string): Promise<string | null> {
  const relative = pathname.replace(/^\/+/, "");
  const requested = nodePath.join(uiDir, relative);

  // realpath + prefix check: resolves both `..` traversal AND a symlink inside
  // ui/ that points outside it, catching either the same way. A target that
  // doesn't exist (ENOENT) or can't be resolved is "not found", not an error —
  // callers must not distinguish "doesn't exist" from "escapes ui/" in their
  // response, or that itself would leak which paths exist outside ui/.
  let real: string;
  let realBase: string;
  try {
    [real, realBase] = await Promise.all([fs.promises.realpath(requested), fs.promises.realpath(uiDir)]);
  } catch {
    return null;
  }
  if (real !== realBase && !real.startsWith(realBase + nodePath.sep)) return null;

  const stat = await fs.promises.stat(real).catch(() => null);
  if (!stat?.isFile()) return null;
  return real;
}

/** The actual request handler, exported for direct unit testing without going through Electron's `protocol` module. */
export async function handleCanvasProtocolRequest(db: Database, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: baseHeaders("text/plain; charset=utf-8") });
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return notFound();
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "" || pathname === "/") pathname = "/index.html";

  // App-owned helper script, served for every canvas regardless of its ui/
  // folder contents — not part of any definition, so no DB/definition lookup.
  if (pathname === CANVAS_CLIENT_SCRIPT_PATH) {
    return new Response(CANVAS_CLIENT_SCRIPT_SOURCE, { headers: baseHeaders("text/javascript; charset=utf-8") });
  }

  const canvasId = url.hostname;
  const canvas = getCanvas(db, canvasId);
  if (!canvas) return notFound();

  const uiDir = resolveCanvasUiDir(canvas.definition);
  if (!uiDir) return notFound();

  const filePath = await resolveUiFile(uiDir, pathname);
  if (!filePath) return notFound();

  let data: Buffer;
  try {
    data = await fs.promises.readFile(filePath);
  } catch {
    return notFound();
  }

  return new Response(data, { headers: baseHeaders(contentTypeFor(filePath)) });
}

/** Registers the actual `protocol.handle` request handler. Call once, after the DB is open. */
export function registerCanvasProtocol(db: Database): void {
  protocol.handle(CANVAS_PROTOCOL_SCHEME, async (request) => {
    try {
      return await handleCanvasProtocolRequest(db, request);
    } catch (err) {
      console.error("[canvas-protocol] request failed:", err);
      return new Response("Internal error", { status: 500, headers: baseHeaders("text/plain; charset=utf-8") });
    }
  });
}
