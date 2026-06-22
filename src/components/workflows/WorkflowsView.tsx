import { useEffect, useMemo, useState } from "react";
import { useIpc, onSessionEvent, IPC_CHANNELS } from "@/lib/ipc";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useWorkflowStore } from "@/lib/store/useWorkflowStore";
import { previewCron } from "@/lib/cron";
import { PROVIDER_SHORT_LABELS } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowRunHistory } from "./WorkflowRunHistory";
import { X, Plus, Clock, Hand, Bot, Trash2, Pencil, Eye } from "lucide-react";
import type { Provider, Workflow, WorkflowRun } from "@/types";

interface WorkflowsViewProps {
  onClose: () => void;
}

type EditorTarget = { workflow: Workflow | null } | null;

export function WorkflowsView({ onClose }: WorkflowsViewProps) {
  const ipc = useIpc();
  const { projects, activeProjectId, setActiveProject } = useProjectStore();
  const { workflows, setWorkflows, upsertWorkflow, removeWorkflow, runsByWorkflow, setRuns, applyRunUpdate } =
    useWorkflowStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);
  // Per-workflow in-flight "Run now" tracking so concurrent runs (or quickly
  // switching the selected workflow mid-request) don't clobber each other's
  // running state.
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p.name])),
    [projects]
  );

  // Load all workflows on mount.
  useEffect(() => {
    ipc.workflowList()
      .then((list) => {
        setWorkflows(list);
        setSelectedId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load workflows"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-update run history from WORKFLOW_RUN_UPDATED push events.
  useEffect(() => {
    return onSessionEvent<WorkflowRun>(IPC_CHANNELS.WORKFLOW_RUN_UPDATED, (run) => {
      applyRunUpdate(run);
    });
  }, [applyRunUpdate]);

  // Load run history for the selected workflow.
  useEffect(() => {
    if (!selectedId) return;
    ipc.workflowListRuns(selectedId)
      .then((runs) => setRuns(selectedId, runs))
      .catch(() => setRuns(selectedId, []));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const selected = workflows.find((w) => w.id === selectedId) ?? null;

  const handleRunNow = async (workflow: Workflow) => {
    setRunningIds((s) => new Set(s).add(workflow.id));
    try {
      const run = await ipc.workflowRunNow(workflow.id);
      applyRunUpdate(run);
      // Refresh history so the new row (and any prior rows) are in sync.
      const runs = await ipc.workflowListRuns(workflow.id);
      setRuns(workflow.id, runs);
    } catch (err) {
      console.error("workflowRunNow failed:", err);
    } finally {
      setRunningIds((s) => {
        const next = new Set(s);
        next.delete(workflow.id);
        return next;
      });
    }
  };

  const handleToggleEnabled = async (workflow: Workflow) => {
    try {
      const updated = await ipc.workflowUpsert({ id: workflow.id, enabled: !workflow.enabled });
      upsertWorkflow(updated);
    } catch (err) {
      console.error("toggle enabled failed:", err);
    }
  };

  const handleDelete = async (workflow: Workflow) => {
    if (!window.confirm(`Delete workflow "${workflow.name}"? This also removes its run history.`)) {
      return;
    }
    try {
      await ipc.workflowDelete(workflow.id);
      removeWorkflow(workflow.id);
      setSelectedId((prev) => {
        if (prev !== workflow.id) return prev;
        const remaining = workflows.filter((w) => w.id !== workflow.id);
        return remaining[0]?.id ?? null;
      });
    } catch (err) {
      console.error("workflowDelete failed:", err);
    }
  };

  const handleOpenSession = async (projectId: string, sessionId: string) => {
    try {
      const sessions = await ipc.listSessions(projectId);
      useSessionStore.getState().mergeSessions(sessions);
    } catch (err) {
      console.error("listSessions failed:", err);
    }
    setActiveProject(projectId);
    useSessionStore.getState().setActiveSession(sessionId);
    onClose();
  };

  return (
    <div className="flex flex-1 overflow-hidden bg-background">
      {/* Left nav: workflow list */}
      <nav className="w-64 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
        <div className="flex-none pt-12 px-2 pb-2">
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              setEditorTarget({ workflow: null });
              setSelectedId(null);
            }}
          >
            <Plus className="h-4 w-4" />
            New workflow
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {workflows.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No workflows yet.</p>
          ) : (
            workflows.map((w) => (
              <WorkflowListItem
                key={w.id}
                workflow={w}
                projectName={projectNames[w.project_id] ?? "Unknown project"}
                active={!editorTarget && w.id === selectedId}
                onClick={() => {
                  setEditorTarget(null);
                  setSelectedId(w.id);
                }}
              />
            ))
          )}
        </div>
      </nav>

      {/* Right panel */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between h-12 px-6 border-b border-border flex-shrink-0">
          <h1 className="text-base font-semibold">Workflows</h1>
          <WithTooltip label="Close workflows">
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close workflows">
              <X className="h-4 w-4" />
            </Button>
          </WithTooltip>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loadError && (
            <p className="mb-4 text-sm text-destructive">{loadError}</p>
          )}

          {editorTarget ? (
            <WorkflowEditor
              workflow={editorTarget.workflow}
              defaultProjectId={activeProjectId}
              projects={projects}
              onSaved={(saved) => {
                upsertWorkflow(saved);
                setSelectedId(saved.id);
                setEditorTarget(null);
              }}
              onCancel={() => setEditorTarget(null)}
            />
          ) : selected ? (
            <WorkflowDetail
              workflow={selected}
              projectName={projectNames[selected.project_id] ?? "Unknown project"}
              runs={runsByWorkflow[selected.id] ?? []}
              running={runningIds.has(selected.id)}
              onEdit={() => setEditorTarget({ workflow: selected })}
              onDelete={() => handleDelete(selected)}
              onToggleEnabled={() => handleToggleEnabled(selected)}
              onRunNow={() => handleRunNow(selected)}
              onOpenSession={(sessionId) => handleOpenSession(selected.project_id, sessionId)}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {workflows.length === 0
                ? "Create a workflow to get started."
                : "Select a workflow to view its details."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkflowListItem({
  workflow,
  projectName,
  active,
  onClick,
}: {
  workflow: Workflow;
  projectName: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full flex-shrink-0",
            workflow.enabled ? "bg-green-500" : "bg-muted-foreground/40"
          )}
          aria-label={workflow.enabled ? "Enabled" : "Disabled"}
        />
        <span className="flex-1 truncate font-medium text-foreground">{workflow.name}</span>
        {workflow.cron && (
          <Clock className="h-3 w-3 flex-shrink-0" aria-label="Cron trigger" />
        )}
        {workflow.watch_path && (
          <Eye className="h-3 w-3 flex-shrink-0" aria-label="File trigger" />
        )}
        {!workflow.cron && !workflow.watch_path && (
          <Hand className="h-3 w-3 flex-shrink-0" aria-label="Manual only" />
        )}
      </div>
      <span className="block truncate text-xs text-muted-foreground pl-3">{projectName}</span>
    </button>
  );
}

function WorkflowDetail({
  workflow,
  projectName,
  runs,
  running,
  onEdit,
  onDelete,
  onToggleEnabled,
  onRunNow,
  onOpenSession,
}: {
  workflow: Workflow;
  projectName: string;
  runs: WorkflowRun[];
  running: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onRunNow: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const preview = previewCron(workflow.cron ?? "");
  const providerLabel = workflow.provider
    ? PROVIDER_SHORT_LABELS[workflow.provider as Provider]
    : "Project default";

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold truncate">{workflow.name}</h2>
            {workflow.autonomy === "autonomous" && (
              <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                Autonomous
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{projectName}</p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <WithTooltip label="Edit workflow">
            <Button variant="ghost" size="icon" onClick={onEdit} aria-label="Edit workflow">
              <Pencil className="h-4 w-4" />
            </Button>
          </WithTooltip>
          <WithTooltip label="Delete workflow">
            <Button variant="ghost" size="icon" onClick={onDelete} aria-label="Delete workflow">
              <Trash2 className="h-4 w-4" />
            </Button>
          </WithTooltip>
        </div>
      </div>

      {/* Prompt */}
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
        <p className="whitespace-pre-wrap text-sm">{workflow.prompt}</p>
      </div>

      {/* Meta grid */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Meta label="Schedule">
          <span className={cn("flex items-center gap-1.5", !preview.valid && "text-destructive")}>
            {workflow.cron ? (
              <>
                <code className="font-mono text-xs">{workflow.cron}</code>
              </>
            ) : (
              <span className="text-muted-foreground">Manual only</span>
            )}
          </span>
          {workflow.cron && <span className="text-xs text-muted-foreground">{preview.label}</span>}
        </Meta>
        <Meta label="File trigger">
          {workflow.watch_path ? (
            <span className="flex items-center gap-1.5">
              <Eye className="h-3.5 w-3.5 flex-shrink-0" />
              <code className="font-mono text-xs truncate">{workflow.watch_path}</code>
            </span>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </Meta>
        <Meta label="Provider / model">
          <span>{providerLabel}</span>
          {workflow.model && <span className="text-xs text-muted-foreground">{workflow.model}</span>}
        </Meta>
        <Meta label="Agent / skills">
          <span className="flex items-center gap-1.5">
            {workflow.agent ? (
              <>
                <Bot className="h-3.5 w-3.5" />
                {workflow.agent}
              </>
            ) : (
              <span className="text-muted-foreground">Default</span>
            )}
          </span>
          {workflow.skills && workflow.skills.length > 0 && (
            <span className="text-xs text-muted-foreground">{workflow.skills.join(", ")}</span>
          )}
        </Meta>
        <Meta label="Session strategy">
          <span className="capitalize">{workflow.session_strategy}</span>
        </Meta>
      </dl>

      {/* Enabled toggle */}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={workflow.enabled}
          onChange={onToggleEnabled}
          className="h-4 w-4 rounded border-input accent-primary"
        />
        <span>Enabled</span>
      </label>

      <div className="border-t border-border pt-4">
        <WorkflowRunHistory
          runs={runs}
          running={running}
          onRunNow={onRunNow}
          onOpenSession={onOpenSession}
        />
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</dt>
      <dd className="flex flex-col gap-0.5">{children}</dd>
    </div>
  );
}
