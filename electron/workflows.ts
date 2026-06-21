import * as crypto from "crypto";
import type { Database } from "better-sqlite3";
import type {
  Provider,
  Workflow,
  WorkflowAutonomy,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunTrigger,
  WorkflowSessionStrategy,
} from "../src/types/index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Defensive parse: returns null for null/empty input, drops non-string entries,
 * dedupes, and silently swallows JSON errors (returning null) so a corrupted
 * row never throws on hydration. Mirrors the helper in sessions.ts.
 */
function parseJsonStringArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const cleaned = [...new Set(parsed.filter((v): v is string => typeof v === "string"))];
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

function serializeSkills(skills: string[] | null | undefined): string | null {
  if (!skills || skills.length === 0) return null;
  // Trim before filtering so whitespace-only names ("  ") don't survive as
  // "real" skills and produce odd lookup paths (.../skills/ /SKILL.md).
  const cleaned = [
    ...new Set(
      skills
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    ),
  ];
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
}

interface WorkflowRowShape {
  id: string;
  project_id: string;
  name: string;
  prompt: string;
  provider: string | null;
  model: string | null;
  agent: string | null;
  skills: string | null;
  cron: string | null;
  enabled: number;
  session_strategy: string;
  reuse_session_id: string | null;
  autonomy: string;
  created_at: string;
  last_run_at: string | null;
}

function rowToWorkflow(row: WorkflowRowShape): Workflow {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    prompt: row.prompt,
    provider: row.provider as Provider | null,
    model: row.model,
    agent: row.agent,
    skills: parseJsonStringArray(row.skills),
    cron: row.cron,
    enabled: row.enabled !== 0,
    session_strategy: row.session_strategy as WorkflowSessionStrategy,
    reuse_session_id: row.reuse_session_id,
    autonomy: row.autonomy as WorkflowAutonomy,
    created_at: row.created_at,
    last_run_at: row.last_run_at,
  };
}

const WORKFLOW_COLUMNS =
  "id, project_id, name, prompt, provider, model, agent, skills, cron, enabled, session_strategy, reuse_session_id, autonomy, created_at, last_run_at";

// ─── Workflow CRUD ─────────────────────────────────────────────────────────────

export interface CreateWorkflowInput {
  projectId: string;
  name: string;
  prompt: string;
  provider?: Provider | null;
  model?: string | null;
  agent?: string | null;
  skills?: string[] | null;
  cron?: string | null;
  enabled?: boolean;
  sessionStrategy?: WorkflowSessionStrategy;
  reuseSessionId?: string | null;
  autonomy?: WorkflowAutonomy;
  /** Override the generated id (tests). */
  id?: string;
}

/** Create a new workflow and return it. */
export function createWorkflow(db: Database, input: CreateWorkflowInput): Workflow {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = nowIso();
  const enabled = input.enabled ?? true;
  const sessionStrategy = input.sessionStrategy ?? "fresh";
  const autonomy = input.autonomy ?? "interactive";
  // reuse_session_id is only meaningful for the "reuse" strategy — never persist
  // one on a "fresh" workflow, even if the caller passed it.
  const reuseSessionId = sessionStrategy === "reuse" ? input.reuseSessionId ?? null : null;

  db.prepare(
    `INSERT INTO workflows
       (id, project_id, name, prompt, provider, model, agent, skills, cron, enabled, session_strategy, reuse_session_id, autonomy, created_at, last_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    id,
    input.projectId,
    input.name,
    input.prompt,
    input.provider ?? null,
    input.model ?? null,
    input.agent ?? null,
    serializeSkills(input.skills),
    input.cron ?? null,
    enabled ? 1 : 0,
    sessionStrategy,
    reuseSessionId,
    autonomy,
    createdAt
  );

  return {
    id,
    project_id: input.projectId,
    name: input.name,
    prompt: input.prompt,
    provider: input.provider ?? null,
    model: input.model ?? null,
    agent: input.agent ?? null,
    skills: parseJsonStringArray(serializeSkills(input.skills)),
    cron: input.cron ?? null,
    enabled,
    session_strategy: sessionStrategy,
    reuse_session_id: reuseSessionId,
    autonomy,
    created_at: createdAt,
    last_run_at: null,
  };
}

/** List workflows, optionally filtered to a project, oldest first. */
export function listWorkflows(db: Database, projectId?: string): Workflow[] {
  const rows = projectId
    ? (db
        .prepare(`SELECT ${WORKFLOW_COLUMNS} FROM workflows WHERE project_id = ? ORDER BY created_at ASC`)
        .all(projectId) as WorkflowRowShape[])
    : (db
        .prepare(`SELECT ${WORKFLOW_COLUMNS} FROM workflows ORDER BY created_at ASC`)
        .all() as WorkflowRowShape[]);
  return rows.map(rowToWorkflow);
}

/** Fetch a single workflow, or null if it does not exist. */
export function getWorkflow(db: Database, id: string): Workflow | null {
  const row = db
    .prepare(`SELECT ${WORKFLOW_COLUMNS} FROM workflows WHERE id = ?`)
    .get(id) as WorkflowRowShape | undefined;
  return row ? rowToWorkflow(row) : null;
}

/** Fields that {@link updateWorkflow} can patch. */
export type WorkflowPatch = Partial<
  Pick<
    Workflow,
    | "name"
    | "prompt"
    | "provider"
    | "model"
    | "agent"
    | "skills"
    | "cron"
    | "enabled"
    | "session_strategy"
    | "reuse_session_id"
    | "autonomy"
  >
>;

/**
 * Merge a patch onto an existing workflow and persist. Returns the updated
 * workflow, or null if the id does not exist.
 */
export function updateWorkflow(db: Database, id: string, patch: WorkflowPatch): Workflow | null {
  const existing = getWorkflow(db, id);
  if (!existing) return null;

  // Only apply keys that were explicitly provided. `null` is a legitimate value
  // for nullable columns, but an `undefined` in the patch must not overwrite a
  // required field (it would bind as undefined and throw in better-sqlite3).
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined)
  ) as WorkflowPatch;

  const next: Workflow = {
    ...existing,
    ...defined,
    // skills is stored serialized; re-normalize whatever the patch passed.
    skills:
      defined.skills !== undefined
        ? parseJsonStringArray(serializeSkills(defined.skills))
        : existing.skills,
  };

  // Keep the row self-consistent: reuse_session_id is only valid under the
  // "reuse" strategy. Switching to "fresh" (or setting an id without the
  // strategy) must not leave a stale id the scheduler could later resume.
  if (next.session_strategy !== "reuse") {
    next.reuse_session_id = null;
  }

  db.prepare(
    `UPDATE workflows SET
       name = ?, prompt = ?, provider = ?, model = ?, agent = ?, skills = ?,
       cron = ?, enabled = ?, session_strategy = ?, reuse_session_id = ?, autonomy = ?
     WHERE id = ?`
  ).run(
    next.name,
    next.prompt,
    next.provider,
    next.model,
    next.agent,
    serializeSkills(next.skills),
    next.cron,
    next.enabled ? 1 : 0,
    next.session_strategy,
    next.reuse_session_id,
    next.autonomy,
    id
  );

  return next;
}

/** Toggle a workflow's enabled flag. */
export function setWorkflowEnabled(db: Database, id: string, enabled: boolean): void {
  db.prepare("UPDATE workflows SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

/** Persist the session id a "reuse"-strategy workflow runs in. */
export function setWorkflowReuseSession(db: Database, id: string, sessionId: string | null): void {
  db.prepare("UPDATE workflows SET reuse_session_id = ? WHERE id = ?").run(sessionId, id);
}

/** Stamp the workflow's last-run timestamp (defaults to now). */
export function updateWorkflowLastRun(db: Database, id: string, iso: string = nowIso()): void {
  db.prepare("UPDATE workflows SET last_run_at = ? WHERE id = ?").run(iso, id);
}

/** Hard-delete a workflow and its run history (cascade via foreign key). */
export function deleteWorkflow(db: Database, id: string): void {
  db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
}

// ─── Workflow run history ──────────────────────────────────────────────────────

interface WorkflowRunRowShape {
  id: string;
  workflow_id: string;
  session_id: string | null;
  status: string;
  trigger: string;
  started_at: string;
  ended_at: string | null;
  error: string | null;
}

function rowToWorkflowRun(row: WorkflowRunRowShape): WorkflowRun {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    session_id: row.session_id,
    status: row.status as WorkflowRunStatus,
    trigger: row.trigger as WorkflowRunTrigger,
    started_at: row.started_at,
    ended_at: row.ended_at,
    error: row.error,
  };
}

const WORKFLOW_RUN_COLUMNS =
  "id, workflow_id, session_id, status, trigger, started_at, ended_at, error";

export interface CreateWorkflowRunInput {
  workflowId: string;
  trigger: WorkflowRunTrigger;
  sessionId?: string | null;
  /** Override the generated id (tests). */
  id?: string;
}

/** Record the start of a workflow run (status "running"). */
export function createWorkflowRun(db: Database, input: CreateWorkflowRunInput): WorkflowRun {
  const id = input.id ?? crypto.randomUUID();
  const startedAt = nowIso();

  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, session_id, status, trigger, started_at, ended_at, error)
     VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL)`
  ).run(id, input.workflowId, input.sessionId ?? null, input.trigger, startedAt);

  return {
    id,
    workflow_id: input.workflowId,
    session_id: input.sessionId ?? null,
    status: "running",
    trigger: input.trigger,
    started_at: startedAt,
    ended_at: null,
    error: null,
  };
}

/**
 * Finalize a workflow run. Sets `ended_at` to now and records an error message
 * when the status is "error".
 */
export function finishWorkflowRun(
  db: Database,
  id: string,
  status: Exclude<WorkflowRunStatus, "running">,
  error?: string | null
): void {
  // Only an "error" run carries an error message; clear it for every other
  // terminal status so a stray/reused argument can't leave stale error text.
  const errorText = status === "error" ? (error ?? null) : null;
  db.prepare(
    "UPDATE workflow_runs SET status = ?, ended_at = ?, error = ? WHERE id = ?"
  ).run(status, nowIso(), errorText, id);
}

/** Attach (or update) the session a run executed in. */
export function setWorkflowRunSession(db: Database, id: string, sessionId: string | null): void {
  db.prepare("UPDATE workflow_runs SET session_id = ? WHERE id = ?").run(sessionId, id);
}

/** Fetch a single workflow run, or null if it does not exist. */
export function getWorkflowRun(db: Database, id: string): WorkflowRun | null {
  const row = db
    .prepare(`SELECT ${WORKFLOW_RUN_COLUMNS} FROM workflow_runs WHERE id = ?`)
    .get(id) as WorkflowRunRowShape | undefined;
  return row ? rowToWorkflowRun(row) : null;
}

/** List a workflow's runs, most recent first. */
export function listWorkflowRuns(db: Database, workflowId: string): WorkflowRun[] {
  const rows = db
    .prepare(
      `SELECT ${WORKFLOW_RUN_COLUMNS} FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC`
    )
    .all(workflowId) as WorkflowRunRowShape[];
  return rows.map(rowToWorkflowRun);
}
