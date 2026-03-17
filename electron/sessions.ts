import * as crypto from "crypto";
import type { Database } from "better-sqlite3";
import type { Message, Session } from "../src/types/index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Exported functions ──────────────────────────────────────────────────────

/**
 * Create a new idle session for a project.
 * Provider and model are inherited from the project config at creation time
 * so each session remembers which model it was started with.
 */
export function createSession(
  db: Database,
  projectId: string,
  provider: string | null = null,
  model: string | null = null
): Session {
  const id = crypto.randomUUID();
  const createdAt = nowIso();

  db.prepare(
    "INSERT INTO sessions (id, project_id, title, status, created_at, provider, model) VALUES (?, ?, 'New session', 'idle', ?, ?, ?)"
  ).run(id, projectId, createdAt, provider, model);

  return {
    id,
    project_id: projectId,
    title: "New session",
    status: "idle",
    created_at: createdAt,
    messages: [],
    provider,
    model,
  };
}

/**
 * List all sessions for a project (metadata only — messages are not loaded).
 */
export function listSessions(db: Database, projectId: string): Session[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, title, status, created_at, provider, model
       FROM sessions
       WHERE project_id = ?
       ORDER BY created_at ASC`
    )
    .all(projectId) as {
    id: string;
    project_id: string;
    title: string;
    status: string;
    created_at: string;
    provider: string | null;
    model: string | null;
  }[];

  return rows.map((row) => ({
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    status: row.status as Session["status"],
    created_at: row.created_at,
    messages: [],
    provider: row.provider,
    model: row.model,
  }));
}

/**
 * Fetch a single session with its full message history.
 */
export function getSession(db: Database, sessionId: string): Session {
  const row = db
    .prepare(
      "SELECT id, project_id, title, status, created_at, provider, model FROM sessions WHERE id = ?"
    )
    .get(sessionId) as
    | {
        id: string;
        project_id: string;
        title: string;
        status: string;
        created_at: string;
        provider: string | null;
        model: string | null;
      }
    | undefined;

  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const messageRows = db
    .prepare(
      `SELECT id, session_id, role, content, created_at
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC`
    )
    .all(sessionId) as {
    id: string;
    session_id: string;
    role: string;
    content: string;
    created_at: string;
  }[];

  const messages: Message[] = messageRows.map((m) => ({
    id: m.id,
    session_id: m.session_id,
    role: m.role as Message["role"],
    content: m.content,
    tool_calls: [],
    created_at: m.created_at,
  }));

  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    status: row.status as Session["status"],
    created_at: row.created_at,
    messages,
    provider: row.provider,
    model: row.model,
  };
}

/**
 * Hard-delete a session and its messages (cascade via foreign key).
 */
export function deleteSession(db: Database, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

/**
 * Persist a single message to SQLite and return it with its generated id.
 */
export function saveMessage(
  db: Database,
  args: { sessionId: string; role: string; content: string }
): Message {
  const id = crypto.randomUUID();
  const createdAt = nowIso();

  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, args.sessionId, args.role, args.content, createdAt);

  return {
    id,
    session_id: args.sessionId,
    role: args.role as Message["role"],
    content: args.content,
    tool_calls: [],
    created_at: createdAt,
  };
}

/**
 * Update the session title (called after the first user message is processed).
 */
export function updateSessionTitle(
  db: Database,
  sessionId: string,
  title: string
): void {
  db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, sessionId);
}

/**
 * Update the provider and model for a session (changed from the model picker).
 */
export function updateSessionModel(
  db: Database,
  sessionId: string,
  provider: string,
  model: string
): void {
  db.prepare("UPDATE sessions SET provider = ?, model = ? WHERE id = ?").run(
    provider,
    model,
    sessionId
  );
}
