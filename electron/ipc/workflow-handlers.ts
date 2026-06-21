import type { Database } from "better-sqlite3";
import * as CH from "../ipc-channels";
import type { Workflow, WorkflowRun } from "../../src/types/index";
import type { WorkflowUpsertInput } from "../ipc-contract";
import {
  createWorkflow,
  getWorkflow,
  listWorkflowRuns,
  updateWorkflow,
  type WorkflowPatch,
} from "../workflows";
import type { WorkflowScheduler } from "../agent/workflow-scheduler";
import { handle } from "./handle";
import { IpcError } from "./errors";

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
 * Workflow IPC: create/update/delete a workflow, list its run history, and
 * trigger a manual "Run now".
 *
 * Cron expressions are validated (via `croner`) in `electron/ipc/validators.ts`
 * before these handlers run, so an unparseable schedule is rejected at the
 * boundary. Every mutation re-arms (or cancels) the workflow's `croner` job
 * through the {@link WorkflowScheduler} so saved changes take effect without a
 * restart.
 */
export function registerWorkflowHandlers(db: Database, scheduler: WorkflowScheduler): void {
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
      // Re-arm so an edited cron / toggled enabled flag takes effect immediately.
      scheduler.rearm(updated.id);
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
    const created = createWorkflow(db, {
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
    // Arm the new workflow's job (no-op unless it is enabled and has a cron).
    scheduler.rearm(created.id);
    return created;
  });

  handle(CH.WORKFLOW_RUN_NOW, (_event, args: { workflowId: string }): Promise<WorkflowRun> =>
    scheduler.runNow(args.workflowId, "manual")
  );

  handle(CH.WORKFLOW_DELETE, (_event, args: { workflowId: string }): { ok: boolean } => {
    // Cancel the armed job before removing rows so a tick can't fire mid-delete.
    scheduler.delete(args.workflowId);
    return { ok: true };
  });

  handle(CH.WORKFLOW_LIST_RUNS, (_event, args: { workflowId: string }): WorkflowRun[] =>
    listWorkflowRuns(db, args.workflowId)
  );
}
