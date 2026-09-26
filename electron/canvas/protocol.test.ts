// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../db";
import { createCanvas } from "./store";
import { _setCanvasesRootForTests } from "./definitions";
import {
  CANVAS_CLIENT_SCRIPT_PATH,
  handleCanvasProtocolRequest,
} from "./protocol";

let db: Database.Database;
let canvasesRoot: string;
let outsideDir: string;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'P', '/tmp/p1', 'now')").run();

  canvasesRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-protocol-"));
  outsideDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-protocol-outside-"));
  _setCanvasesRootForTests(canvasesRoot);
});

afterEach(() => {
  fs.rmSync(canvasesRoot, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
  _setCanvasesRootForTests(null);
});

function writeUiFile(definition: string, relativePath: string, content: string): void {
  const full = nodePath.join(canvasesRoot, definition, "ui", relativePath);
  fs.mkdirSync(nodePath.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("handleCanvasProtocolRequest", () => {
  it("serves the client helper script for any canvas id, with the CSP header", async () => {
    const res = await handleCanvasProtocolRequest(
      db,
      new Request(`aichemist-canvas://nonexistent-canvas${CANVAS_CLIENT_SCRIPT_PATH}`)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src aichemist-canvas: 'unsafe-inline'; connect-src 'none'"
    );
    const body = await res.text();
    expect(body).toContain("window.canvas");
    expect(body).toContain("onState");
    expect(body).toContain("onMessage");
  });

  it("serves a definition's ui/index.html for its canvas id", async () => {
    writeUiFile("kanban", "index.html", "<html><body>Kanban</body></html>");
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });

    const res = await handleCanvasProtocolRequest(db, new Request(`aichemist-canvas://${canvas.id}/`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src aichemist-canvas: 'unsafe-inline'; connect-src 'none'"
    );
    expect(await res.text()).toBe("<html><body>Kanban</body></html>");
  });

  it("serves a nested asset under ui/ with the right content type", async () => {
    writeUiFile("kanban", "app.js", "console.log('hi');");
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });

    const res = await handleCanvasProtocolRequest(db, new Request(`aichemist-canvas://${canvas.id}/app.js`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toBe("console.log('hi');");
  });

  it("404s for an unknown canvas id", async () => {
    const res = await handleCanvasProtocolRequest(db, new Request("aichemist-canvas://does-not-exist/index.html"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  });

  it("404s when the definition has no ui/ folder", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "no-ui", title: "Board" });
    const res = await handleCanvasProtocolRequest(db, new Request(`aichemist-canvas://${canvas.id}/index.html`));
    expect(res.status).toBe(404);
  });

  it("404s for a missing file within an existing ui/ folder", async () => {
    writeUiFile("kanban", "index.html", "<html></html>");
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const res = await handleCanvasProtocolRequest(db, new Request(`aichemist-canvas://${canvas.id}/missing.js`));
    expect(res.status).toBe(404);
  });

  it("refuses a symlink inside ui/ that escapes to outside the definition's folder", async () => {
    const secret = nodePath.join(outsideDir, "secret.txt");
    fs.writeFileSync(secret, "top secret");
    writeUiFile("kanban", "index.html", "<html></html>");
    const uiDir = nodePath.join(canvasesRoot, "kanban", "ui");
    fs.symlinkSync(secret, nodePath.join(uiDir, "escape.txt"));
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });

    const res = await handleCanvasProtocolRequest(db, new Request(`aichemist-canvas://${canvas.id}/escape.txt`));
    expect(res.status).toBe(404);
  });

  it("refuses a `..`-traversing definition name recorded on the canvas row", async () => {
    // The URL parser itself collapses `..` in the request path (see the
    // module docstring), so the realistic bypass this guards is an attacker
    // (or a corrupted row) supplying an unsafe `definition` directly — the
    // CANVAS_CREATE validator doesn't format-check it, so resolution must.
    const canvas = createCanvas(db, { projectId: "p1", definition: "../../etc", title: "Evil" });
    const res = await handleCanvasProtocolRequest(db, new Request(`aichemist-canvas://${canvas.id}/index.html`));
    expect(res.status).toBe(404);
  });

  it("rejects a non-GET/HEAD method", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const res = await handleCanvasProtocolRequest(
      db,
      new Request(`aichemist-canvas://${canvas.id}/index.html`, { method: "POST" })
    );
    expect(res.status).toBe(405);
  });
});
