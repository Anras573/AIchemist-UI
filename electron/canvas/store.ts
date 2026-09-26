import * as crypto from "crypto";
import type { Database } from "better-sqlite3";
import type { Canvas, CanvasListItem, CanvasTrust } from "../../src/types/index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/** State documents are capped at 1 MB — larger data belongs in the canvas's own storage. */
export const CANVAS_STATE_MAX_BYTES = 1024 * 1024;

/**
 * Serializes `state` to JSON and enforces the 1 MB cap. Throws a plain `Error`
 * (message contains "must be", which `classifyError()`'s heuristics map to
 * `invalid_input`) rather than an `IpcError` — this module has no dependency
 * on the IPC layer, matching every other data-layer module (workflows.ts,
 * budget.ts, ...).
 */
function serializeState(state: unknown): string {
  const json = JSON.stringify(state ?? null);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > CANVAS_STATE_MAX_BYTES) {
    throw new Error(
      `Canvas state must be at most ${CANVAS_STATE_MAX_BYTES} bytes (got ${bytes})`
    );
  }
  return json;
}

/** Defensive parse: a corrupted state blob resolves to `null` rather than throwing. */
function parseState(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

interface CanvasRowShape {
  id: string;
  project_id: string;
  definition: string;
  title: string;
  state: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

function rowToCanvas(row: CanvasRowShape): Canvas {
  return {
    id: row.id,
    project_id: row.project_id,
    definition: row.definition,
    title: row.title,
    state: parseState(row.state),
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const CANVAS_COLUMNS = "id, project_id, definition, title, state, revision, created_at, updated_at";

// ─── Canvas instance CRUD ────────────────────────────────────────────────────

export interface CreateCanvasInput {
  projectId: string;
  definition: string;
  title: string;
  /** Seeds `state`. Defaults to `null`. Subject to the same 1 MB cap as `setCanvasState`. */
  initialState?: unknown;
  /** Override the generated id (tests). */
  id?: string;
}

/** Create a new canvas instance and return it. */
export function createCanvas(db: Database, input: CreateCanvasInput): Canvas {
  const id = input.id ?? crypto.randomUUID();
  const timestamp = nowIso();
  const state = serializeState(input.initialState ?? null);

  db.prepare(
    `INSERT INTO canvases (id, project_id, definition, title, state, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(id, input.projectId, input.definition, input.title, state, timestamp, timestamp);

  return {
    id,
    project_id: input.projectId,
    definition: input.definition,
    title: input.title,
    state: parseState(state),
    revision: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/** Fetch a single canvas instance, or null if it does not exist. */
export function getCanvas(db: Database, id: string): Canvas | null {
  const row = db.prepare(`SELECT ${CANVAS_COLUMNS} FROM canvases WHERE id = ?`).get(id) as
    | CanvasRowShape
    | undefined;
  return row ? rowToCanvas(row) : null;
}

/**
 * List a project's canvas instances, oldest first. When `sessionId` is given,
 * each item's `attached` flag reflects whether that session currently has it
 * attached; omitted, every item reports `attached: false`.
 */
export function listCanvases(db: Database, projectId: string, sessionId?: string): CanvasListItem[] {
  const rows = db
    .prepare(`SELECT ${CANVAS_COLUMNS} FROM canvases WHERE project_id = ? ORDER BY created_at ASC`)
    .all(projectId) as CanvasRowShape[];

  const attachedIds = sessionId
    ? new Set(
        (
          db
            .prepare("SELECT canvas_id FROM session_canvases WHERE session_id = ?")
            .all(sessionId) as { canvas_id: string }[]
        ).map((r) => r.canvas_id)
      )
    : new Set<string>();

  return rows.map((row) => ({ ...rowToCanvas(row), attached: attachedIds.has(row.id) }));
}

/**
 * List the canvas instances currently attached to a session. Ordered by the
 * canvas row's insertion order (`rowid`, not `created_at` — two canvases
 * created within the same millisecond would otherwise tie unpredictably, the
 * same reasoning `getSession()`'s pagination cursor uses). Used by the
 * loopback MCP endpoint (#223) to inject only attached canvases' tools into a
 * turn, and by the system-prompt addendum.
 */
export function getAttachedCanvases(db: Database, sessionId: string): Canvas[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.project_id, c.definition, c.title, c.state, c.revision, c.created_at, c.updated_at
       FROM canvases c
       JOIN session_canvases sc ON sc.canvas_id = c.id
       WHERE sc.session_id = ?
       ORDER BY c.rowid ASC`
    )
    .all(sessionId) as CanvasRowShape[];
  return rows.map(rowToCanvas);
}

/** Rename a canvas instance. Returns the updated canvas, or null if it does not exist. */
export function renameCanvas(db: Database, id: string, title: string): Canvas | null {
  const existing = getCanvas(db, id);
  if (!existing) return null;

  const updatedAt = nowIso();
  db.prepare("UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?").run(title, updatedAt, id);
  return { ...existing, title, updated_at: updatedAt };
}

/** Delete a canvas instance. Cascades its `session_canvases` attachments via the foreign key. */
export function deleteCanvas(db: Database, id: string): void {
  db.prepare("DELETE FROM canvases WHERE id = ?").run(id);
}

// ─── Session attachment ──────────────────────────────────────────────────────

/**
 * Attach or detach a canvas instance for a session. Idempotent — attaching an
 * already-attached canvas (or detaching one that isn't attached) is a no-op.
 */
export function setCanvasAttached(
  db: Database,
  sessionId: string,
  canvasId: string,
  attached: boolean
): void {
  if (attached) {
    db.prepare(
      "INSERT OR IGNORE INTO session_canvases (session_id, canvas_id) VALUES (?, ?)"
    ).run(sessionId, canvasId);
  } else {
    db.prepare(
      "DELETE FROM session_canvases WHERE session_id = ? AND canvas_id = ?"
    ).run(sessionId, canvasId);
  }
}

/** Whether a canvas instance is currently attached to a session. */
export function isCanvasAttached(db: Database, sessionId: string, canvasId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM session_canvases WHERE session_id = ? AND canvas_id = ?")
    .get(sessionId, canvasId);
  return row !== undefined;
}

// ─── State ───────────────────────────────────────────────────────────────────

/** Read a canvas instance's persisted state. Throws if the canvas does not exist. */
export function getCanvasState(db: Database, id: string): unknown {
  const canvas = getCanvas(db, id);
  if (!canvas) {
    throw new Error(`Canvas not found: ${id}`);
  }
  return canvas.state;
}

/**
 * Replace a canvas instance's state, bumping `revision` and `updated_at`.
 * Rejects (leaving the stored state unchanged) when the serialized state
 * exceeds {@link CANVAS_STATE_MAX_BYTES}. Throws if the canvas does not exist.
 */
export function setCanvasState(db: Database, id: string, state: unknown): Canvas {
  const existing = getCanvas(db, id);
  if (!existing) {
    throw new Error(`Canvas not found: ${id}`);
  }

  // Serialize (and enforce the cap) before touching the row, so an oversized
  // write throws without mutating anything.
  const json = serializeState(state);
  const updatedAt = nowIso();
  const revision = existing.revision + 1;

  db.prepare(
    "UPDATE canvases SET state = ?, revision = ?, updated_at = ? WHERE id = ?"
  ).run(json, revision, updatedAt, id);

  return { ...existing, state: parseState(json), revision, updated_at: updatedAt };
}

// ─── Trust ───────────────────────────────────────────────────────────────────

/** Read the trust record for a project + definition pair, or null if never trusted. */
export function getCanvasTrust(db: Database, projectId: string, definition: string): CanvasTrust | null {
  const row = db
    .prepare(
      "SELECT project_id, definition, content_hash, trusted_at FROM canvas_trust WHERE project_id = ? AND definition = ?"
    )
    .get(projectId, definition) as CanvasTrust | undefined;
  return row ?? null;
}

/**
 * Record (or refresh) consent to run a definition's server code in a project.
 * Upserts on the `(project_id, definition)` primary key — trusting again after
 * an edit (a new `contentHash`) simply overwrites the prior record.
 */
export function setCanvasTrust(
  db: Database,
  projectId: string,
  definition: string,
  contentHash: string
): CanvasTrust {
  const trustedAt = nowIso();
  db.prepare(
    `INSERT INTO canvas_trust (project_id, definition, content_hash, trusted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id, definition) DO UPDATE SET content_hash = excluded.content_hash, trusted_at = excluded.trusted_at`
  ).run(projectId, definition, contentHash, trustedAt);

  return { project_id: projectId, definition, content_hash: contentHash, trusted_at: trustedAt };
}
