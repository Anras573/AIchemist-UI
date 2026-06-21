import type { Database } from "better-sqlite3";
import type { BrowserWindow } from "electron";
import * as CH from "../ipc-channels";
import type { Workflow } from "../../src/types/index";
import type { WorkflowUpsertInput } from "../ipc-contract";
import { createWorkflow, getWorkflow, updateWorkflow, type WorkflowPatch } from "../workflows";
import { runWorkflow } from "../agent/workflow-scheduler";
import { handle } from "./handle";
import { IpcError } from "./errors";
import type { TurnQueueContext } from "./agent-turn-queue";

/** Trim a nullable string; leaves null/undefined untouched (no value to clean). */
function trimNullable(v: string | null | undefined): string | null | undefined {
  return v == null ? v : v.trim();
}

/**
 * Normalize a nullable override field (model/agent): trim a provided string and
 * coerce a whitespace-only value to `null` (a deliberate "clear"), while
 * preserving an explicit `null` and an absent `undefined` (don't-touch).
 */
function normalizeOverride(v: string | null | undefined): string | null | undefined {
  if (v == null) return v;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Workflow IPC: create/update a workflow and trigger a manual "Run now".
 *
 * Cron expressions are validated (via `croner`) in `electron/ipc/validators.ts`
 * before these handlers run, so an unparseable schedule is rejected at the
 * boundary. Scheduler arming on boot/edit is a later phase — these handlers only
 * persist the workflow and run it on demand.
 */
export function registerWorkflowHandlers(
  db: Database,
  activeTurns: Set<string>,
  getMainWindow: () => BrowserWindow | null
): void {
  const queue: TurnQueueContext = { db, activeTurns, getMainWindow };

  handle(CH.WORKFLOW_UPSERT, (_event, input: WorkflowUpsertInput): Workflow => {
    // Normalize free-text fields so whitespace-only values can't slip past the
    // emptiness checks and stale whitespace variants don't get persisted. The
    // validator already rejects whitespace-only values; trim defensively here so
    // padded-but-valid inputs are stored clean too (the validator only checks,
    // it doesn't transform the args the handler receives).
    const id = input.id?.trim() || undefined; // all-whitespace id → generate a UUID
    const name = input.name?.trim();
    const prompt = input.prompt?.trim();
    const cron = trimNullable(input.cron);
    const reuseSessionId = trimNullable(input.reuseSessionId);
    // model/agent are nullable overrides: trim, and coerce whitespace-only to
    // null (a "clear") while preserving an explicit null and an absent undefined.
    const model = normalizeOverride(input.model);
    const agent = normalizeOverride(input.agent);

    // Update path: an id that resolves to an existing workflow patches it.
    if (id && getWorkflow(db, id)) {
      const patch: WorkflowPatch = {};
      if (name !== undefined) patch.name = name;
      if (prompt !== undefined) patch.prompt = prompt;
      if (input.provider !== undefined) patch.provider = input.provider;
      if (model !== undefined) patch.model = model;
      if (agent !== undefined) patch.agent = agent;
      if (input.skills !== undefined) patch.skills = input.skills;
      if (cron !== undefined) patch.cron = cron;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.sessionStrategy !== undefined) patch.session_strategy = input.sessionStrategy;
      if (reuseSessionId !== undefined) patch.reuse_session_id = reuseSessionId;
      if (input.autonomy !== undefined) patch.autonomy = input.autonomy;

      const updated = updateWorkflow(db, id, patch);
      // getWorkflow already confirmed existence, so this is non-null; guard anyway.
      if (!updated) throw new IpcError("not_found", `Workflow not found: ${id}`);
      return updated;
    }

    // Create path: projectId, name, and prompt are required (non-empty).
    const projectId = input.projectId?.trim();
    if (!projectId || !name || !prompt) {
      throw new IpcError(
        "invalid_input",
        "Creating a workflow requires projectId, name, and prompt"
      );
    }
    return createWorkflow(db, {
      id,
      projectId,
      name,
      prompt,
      provider: input.provider ?? null,
      model: model ?? null,
      agent: agent ?? null,
      skills: input.skills ?? null,
      cron: cron ?? null,
      enabled: input.enabled,
      sessionStrategy: input.sessionStrategy,
      reuseSessionId: reuseSessionId ?? null,
      autonomy: input.autonomy,
    });
  });

  handle(CH.WORKFLOW_RUN_NOW, (_event, args: { workflowId: string }) =>
    runWorkflow(queue, args.workflowId, "manual")
  );
}
