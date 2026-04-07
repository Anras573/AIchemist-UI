import * as crypto from "crypto";
import type { Database } from "better-sqlite3";
import type { Message, Session, ToolCall, ToolCallStatus, ToolCategory } from "../src/types/index";

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
    agent: null,
    skills: null,
  };
}

/**
 * List all sessions for a project (metadata only — messages are not loaded).
 */
export function listSessions(db: Database, projectId: string): Session[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, title, status, created_at, provider, model, agent, skills
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
    agent: string | null;
    skills: string | null;
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
    agent: row.agent,
    skills: row.skills ? (JSON.parse(row.skills) as string[]) : null,
  }));
}

/**
 * Fetch a single session with its full message history.
 */
export function getSession(db: Database, sessionId: string): Session {
  const row = db
    .prepare(
      "SELECT id, project_id, title, status, created_at, provider, model, agent, skills FROM sessions WHERE id = ?"
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
        agent: string | null;
        skills: string | null;
      }
    | undefined;

  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const messageRows = db
    .prepare(
      `SELECT id, session_id, role, content, created_at, agent
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
    agent: string | null;
  }[];

  // Load tool_calls for all messages in one query and group by message_id
  const toolCallsByMessageId = new Map<string, ToolCall[]>();
  if (messageRows.length > 0) {
    const messageIds = messageRows.map((m) => m.id);
    const placeholders = messageIds.map(() => "?").join(", ");
    const toolCallRows = db
      .prepare(
        `SELECT id, message_id, name, args, result, status, category
         FROM tool_calls
         WHERE message_id IN (${placeholders})
         ORDER BY rowid ASC`
      )
      .all(...messageIds) as {
      id: string;
      message_id: string;
      name: string;
      args: string;
      result: string | null;
      status: string;
      category: string;
    }[];

    for (const row of toolCallRows) {
      const tc: ToolCall = {
        id: row.id,
        name: row.name,
        args: JSON.parse(row.args) as Record<string, unknown>,
        result: row.result ? (JSON.parse(row.result) as unknown) : null,
        status: row.status as ToolCallStatus,
        category: row.category as ToolCategory,
      };
      const existing = toolCallsByMessageId.get(row.message_id) ?? [];
      existing.push(tc);
      toolCallsByMessageId.set(row.message_id, existing);
    }
  }

  const messages: Message[] = messageRows.map((m) => ({
    id: m.id,
    session_id: m.session_id,
    role: m.role as Message["role"],
    content: m.content,
    tool_calls: toolCallsByMessageId.get(m.id) ?? [],
    created_at: m.created_at,
    agent: m.agent,
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
    agent: row.agent,
    skills: row.skills ? (JSON.parse(row.skills) as string[]) : null,
  };
}

/**
 * Hard-delete a session and its messages (cascade via foreign key).
 */
export function deleteSession(db: Database, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

/**
 * Persist the runtime status of a session to SQLite.
 * Called by the agent runner at each status transition so restarts can
 * detect and recover sessions that were interrupted mid-turn.
 */
export function updateSessionStatus(
  db: Database,
  sessionId: string,
  status: Session["status"]
): void {
  db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, sessionId);
}

/**
 * On startup, mark any session still in "running" status as "error".
 * A session can only be "running" if the app crashed or was force-quit
 * mid-turn — it will never complete, so surface it as an error.
 * Returns the number of sessions recovered.
 */
export function recoverStaleSessionStatuses(db: Database): number {
  const result = db
    .prepare("UPDATE sessions SET status = 'error' WHERE status = 'running'")
    .run();
  return result.changes;
}

/**
 * Persist a single message to SQLite and return it with its generated id.
 */
export function saveMessage(
  db: Database,
  args: { sessionId: string; role: string; content: string; agent?: string | null }
): Message {
  const id = crypto.randomUUID();
  const createdAt = nowIso();

  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, created_at, agent) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, args.sessionId, args.role, args.content, createdAt, args.agent ?? null);

  return {
    id,
    session_id: args.sessionId,
    role: args.role as Message["role"],
    content: args.content,
    tool_calls: [],
    created_at: createdAt,
    agent: args.agent ?? null,
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

/**
 * Update the selected sub-agent for a session (null = default agent).
 */
export function updateSessionAgent(
  db: Database,
  sessionId: string,
  agent: string | null
): void {
  db.prepare("UPDATE sessions SET agent = ? WHERE id = ?").run(agent, sessionId);
}

/**
 * Update the active skills for a session (empty array = no skills active).
 */
export function updateSessionSkills(
  db: Database,
  sessionId: string,
  skills: string[]
): void {
  const value = skills.length > 0 ? JSON.stringify(skills) : null;
  db.prepare("UPDATE sessions SET skills = ? WHERE id = ?").run(value, sessionId);
}

// ── Tool call persistence ─────────────────────────────────────────────────────

/**
 * Creates an empty placeholder assistant message at turn start.
 * All tool calls for this turn will reference this message via FK.
 * Returns the newly created message.
 */
export function createPlaceholderMessage(
  db: Database,
  args: { sessionId: string; agent?: string | null }
): Message {
  const id = crypto.randomUUID();
  const createdAt = nowIso();

  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, created_at, agent) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, args.sessionId, "assistant", "", createdAt, args.agent ?? null);

  return {
    id,
    session_id: args.sessionId,
    role: "assistant",
    content: "",
    tool_calls: [],
    created_at: createdAt,
    agent: args.agent ?? null,
  };
}

/**
 * Updates an existing message's content (called at turn end with full text).
 */
export function updateMessageContent(
  db: Database,
  messageId: string,
  content: string
): void {
  db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(content, messageId);
}

/**
 * Inserts a tool_calls row. Call when a tool starts executing.
 */
export function saveToolCall(
  db: Database,
  args: {
    id: string;
    messageId: string;
    name: string;
    args: Record<string, unknown>;
    status: ToolCallStatus;
    category: string;
  }
): void {
  db.prepare(
    "INSERT INTO tool_calls (id, message_id, name, args, result, status, category) VALUES (?, ?, ?, ?, NULL, ?, ?)"
  ).run(
    args.id,
    args.messageId,
    args.name,
    JSON.stringify(args.args),
    args.status,
    args.category
  );
}

/**
 * Updates status (and optionally result) of an existing tool_call row.
 */
export function updateToolCallStatus(
  db: Database,
  id: string,
  status: ToolCallStatus,
  result?: unknown
): void {
  if (result !== undefined) {
    db.prepare("UPDATE tool_calls SET status = ?, result = ? WHERE id = ?").run(
      status,
      JSON.stringify(result),
      id
    );
  } else {
    db.prepare("UPDATE tool_calls SET status = ? WHERE id = ?").run(status, id);
  }
}

/**
 * Loads all tool_calls for a message, ordered by insertion.
 */
export function loadToolCallsForMessage(db: Database, messageId: string): ToolCall[] {
  const rows = db
    .prepare(
      "SELECT id, name, args, result, status, category FROM tool_calls WHERE message_id = ? ORDER BY rowid ASC"
    )
    .all(messageId) as {
    id: string;
    name: string;
    args: string;
    result: string | null;
    status: string;
    category: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    args: JSON.parse(row.args) as Record<string, unknown>,
    result: row.result ? (JSON.parse(row.result) as unknown) : null,
    status: row.status as ToolCallStatus,
    category: row.category as ToolCategory,
  }));
}
