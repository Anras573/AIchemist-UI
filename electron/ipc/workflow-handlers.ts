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
    // Update path: an id that resolves to an existing workflow patches it.
    if (input.id && getWorkflow(db, input.id)) {
      const patch: WorkflowPatch = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.prompt !== undefined) patch.prompt = input.prompt;
      if (input.provider !== undefined) patch.provider = input.provider;
      if (input.model !== undefined) patch.model = input.model;
      if (input.agent !== undefined) patch.agent = input.agent;
      if (input.skills !== undefined) patch.skills = input.skills;
      if (input.cron !== undefined) patch.cron = input.cron;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.sessionStrategy !== undefined) patch.session_strategy = input.sessionStrategy;
      if (input.reuseSessionId !== undefined) patch.reuse_session_id = input.reuseSessionId;
      if (input.autonomy !== undefined) patch.autonomy = input.autonomy;

      const updated = updateWorkflow(db, input.id, patch);
      // getWorkflow already confirmed existence, so this is non-null; guard anyway.
      if (!updated) throw new IpcError("not_found", `Workflow not found: ${input.id}`);
      return updated;
    }

    // Create path: projectId, name, and prompt are required.
    if (!input.projectId || !input.name || !input.prompt) {
      throw new IpcError(
        "invalid_input",
        "Creating a workflow requires projectId, name, and prompt"
      );
    }
    return createWorkflow(db, {
      id: input.id,
      projectId: input.projectId,
      name: input.name,
      prompt: input.prompt,
      provider: input.provider ?? null,
      model: input.model ?? null,
      agent: input.agent ?? null,
      skills: input.skills ?? null,
      cron: input.cron ?? null,
      enabled: input.enabled,
      sessionStrategy: input.sessionStrategy,
      reuseSessionId: input.reuseSessionId ?? null,
      autonomy: input.autonomy,
    });
  });

  handle(CH.WORKFLOW_RUN_NOW, (_event, args: { workflowId: string }) =>
    runWorkflow(queue, args.workflowId, "manual")
  );
}
