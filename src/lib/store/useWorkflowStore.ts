import { create } from "zustand";
import type { Workflow, WorkflowRun } from "@/types";

/**
 * Renderer state for the Workflows view. Workflows and their run history live in
 * SQLite (the source of truth); this store is a cache populated from IPC. Nothing
 * is persisted to localStorage — the data is re-fetched from the backend on mount.
 *
 * `WORKFLOW_RUN_UPDATED` push events flow through {@link applyRunUpdate} so an
 * open run-history panel live-updates as a run transitions running → terminal.
 */
interface WorkflowStore {
  workflows: Workflow[];
  /** Run history keyed by workflow id (most recent first). */
  runsByWorkflow: Record<string, WorkflowRun[]>;

  setWorkflows: (workflows: Workflow[]) => void;
  /** Insert or replace a single workflow (after upsert / run-now stamps). */
  upsertWorkflow: (workflow: Workflow) => void;
  removeWorkflow: (id: string) => void;

  setRuns: (workflowId: string, runs: WorkflowRun[]) => void;
  /** Merge one run (from a WORKFLOW_RUN_UPDATED push) into its workflow's list. */
  applyRunUpdate: (run: WorkflowRun) => void;
}

export const useWorkflowStore = create<WorkflowStore>((set) => ({
  workflows: [],
  runsByWorkflow: {},

  setWorkflows: (workflows) => set({ workflows }),

  upsertWorkflow: (workflow) =>
    set((state) => {
      const exists = state.workflows.some((w) => w.id === workflow.id);
      return {
        workflows: exists
          ? state.workflows.map((w) => (w.id === workflow.id ? workflow : w))
          : [...state.workflows, workflow],
      };
    }),

  removeWorkflow: (id) =>
    set((state) => {
      const { [id]: _dropped, ...rest } = state.runsByWorkflow;
      return {
        workflows: state.workflows.filter((w) => w.id !== id),
        runsByWorkflow: rest,
      };
    }),

  setRuns: (workflowId, runs) =>
    set((state) => ({
      runsByWorkflow: { ...state.runsByWorkflow, [workflowId]: runs },
    })),

  applyRunUpdate: (run) =>
    set((state) => {
      const existing = state.runsByWorkflow[run.workflow_id];
      // Only merge into a list we've already loaded — otherwise we'd show a
      // single orphan run without the surrounding history. The panel re-fetches
      // on open, so an un-cached workflow picks the run up then.
      if (!existing) return state;
      const idx = existing.findIndex((r) => r.id === run.id);
      const next =
        idx >= 0
          ? existing.map((r) => (r.id === run.id ? run : r))
          : [run, ...existing];
      return {
        runsByWorkflow: { ...state.runsByWorkflow, [run.workflow_id]: next },
      };
    }),
}));
