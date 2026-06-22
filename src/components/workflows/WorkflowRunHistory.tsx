import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Play, ExternalLink, Loader2 } from "lucide-react";
import type { WorkflowRun, WorkflowRunStatus } from "@/types";

interface WorkflowRunHistoryProps {
  runs: WorkflowRun[];
  /** True while a manual "Run now" is in flight. */
  running: boolean;
  onRunNow: () => void;
  /** Navigate to the session a run executed in (when it has one). */
  onOpenSession: (sessionId: string) => void;
}

const STATUS_STYLES: Record<WorkflowRunStatus, string> = {
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  success: "bg-green-500/15 text-green-600 dark:text-green-400",
  error: "bg-destructive/15 text-destructive",
  skipped: "bg-muted text-muted-foreground",
};

const STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  running: "Running",
  success: "Success",
  error: "Error",
  skipped: "Skipped",
};

/** Compact "Jun 22, 09:00" style timestamp (always month + day + time). */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human-readable duration between two ISO timestamps. */
function formatDuration(startedAt: string, endedAt: string | null): string | null {
  if (!endedAt) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

export function WorkflowRunHistory({
  runs,
  running,
  onRunNow,
  onOpenSession,
}: WorkflowRunHistoryProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Run history</h3>
        <Button size="sm" onClick={onRunNow} disabled={running}>
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {running ? "Running…" : "Run now"}
        </Button>
      </div>

      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          No runs yet. Use <span className="font-medium">Run now</span> to trigger
          this workflow.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {runs.map((run) => {
            const duration = formatDuration(run.started_at, run.ended_at);
            return (
              <li
                key={run.id}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                    STATUS_STYLES[run.status]
                  )}
                >
                  {STATUS_LABELS[run.status]}
                </span>

                <div className="flex flex-1 flex-col min-w-0">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="capitalize">{run.trigger}</span>
                    <span>·</span>
                    <span>{formatTimestamp(run.started_at)}</span>
                    {duration && (
                      <>
                        <span>·</span>
                        <span>{duration}</span>
                      </>
                    )}
                  </div>
                  {run.error && (
                    <p className="truncate text-xs text-destructive" title={run.error}>
                      {run.error}
                    </p>
                  )}
                </div>

                {run.session_id && (
                  <button
                    type="button"
                    onClick={() => onOpenSession(run.session_id!)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    aria-label="View session"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Session
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
