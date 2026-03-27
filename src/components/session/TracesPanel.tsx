import { useEffect, useCallback, useState } from "react";
import { Activity, ChevronRight, Loader2, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { ipc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";
import type { TraceSpan } from "@/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "…";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StatusDot({ status }: { status: TraceSpan["status"] }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full shrink-0",
        status === "running" && "bg-yellow-400 animate-pulse",
        status === "success" && "bg-emerald-400",
        status === "error" && "bg-destructive"
      )}
    />
  );
}

// ── TurnCard ──────────────────────────────────────────────────────────────────

function TurnCard({ turn, tools }: { turn: TraceSpan; tools: TraceSpan[] }) {
  const [expanded, setExpanded] = useState(false);

  const turnDuration = turn.durationMs ?? (turn.endMs ? undefined : Date.now() - turn.startMs);

  return (
    <div className="rounded-md border bg-card text-card-foreground text-xs">
      {/* Turn header */}
      <button
        className="flex items-center gap-2 w-full px-2.5 py-2 hover:bg-muted/40 transition-colors rounded-md"
        onClick={() => tools.length > 0 && setExpanded((v) => !v)}
      >
        <StatusDot status={turn.status} />
        <span className="flex-1 font-medium text-left truncate">{turn.name}</span>
        {tools.length > 0 && (
          <span className="text-muted-foreground shrink-0">
            {tools.length} tool{tools.length !== 1 ? "s" : ""}
          </span>
        )}
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {formatDuration(turnDuration)}
        </span>
        {tools.length > 0 && (
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground shrink-0 transition-transform",
              expanded && "rotate-90"
            )}
          />
        )}
      </button>

      {/* Tool spans */}
      {expanded && tools.length > 0 && (
        <div className="border-t divide-y">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} turnStartMs={turn.startMs} turnDuration={turn.durationMs} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── ToolRow ───────────────────────────────────────────────────────────────────

const BASH_TOOLS = new Set(["execute_bash", "Bash", "bash", "run_shell"]);
const FILE_TOOLS = new Set(["write_file", "delete_file", "Read", "Write", "Edit", "MultiEdit", "Glob", "LS", "read_file"]);

function getToolSummary(name: string, meta: Record<string, unknown> | undefined): string | null {
  const input = meta?.input as Record<string, unknown> | undefined;
  if (!input) return null;
  if (BASH_TOOLS.has(name)) {
    const cmd = (input.command ?? input.cmd) as string | undefined;
    return cmd ? `$ ${cmd}` : null;
  }
  if (FILE_TOOLS.has(name)) {
    const p = (input.path ?? input.file_path) as string | undefined;
    return p ?? null;
  }
  if (name === "web_fetch") {
    return (input.url as string | undefined) ?? null;
  }
  return null;
}

function ToolRow({
  tool,
  turnStartMs,
  turnDuration,
}: {
  tool: TraceSpan;
  turnStartMs: number;
  turnDuration: number | undefined;
}) {
  const offset = tool.startMs - turnStartMs;
  const duration = tool.durationMs ?? 0;
  const totalMs = turnDuration ?? Math.max(duration + offset, 1);

  const leftPct = Math.min((offset / totalMs) * 100, 95);
  const widthPct = Math.max((duration / totalMs) * 100, 1);

  return (
    <div className="px-2.5 py-1.5 flex flex-col gap-1">
      {/* Name + status + duration */}
      <div className="flex items-center gap-2">
        <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="flex-1 font-mono truncate text-muted-foreground">{tool.name}</span>
        <StatusDot status={tool.status} />
        <span className="tabular-nums text-muted-foreground shrink-0">
          {formatDuration(tool.durationMs)}
        </span>
      </div>
      {/* Command / path / URL summary */}
      {(() => {
        const summary = getToolSummary(tool.name, tool.meta);
        return summary ? (
          <p className="font-mono text-[10px] text-foreground/70 truncate pl-5" title={summary}>
            {summary}
          </p>
        ) : null;
      })()}
      {/* Relative timing bar */}
      {turnDuration !== undefined && (
        <div className="relative h-1 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              "absolute top-0 h-full rounded-full",
              tool.status === "success" && "bg-primary/60",
              tool.status === "running" && "bg-yellow-400/60 animate-pulse",
              tool.status === "error" && "bg-destructive/60"
            )}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ── TracesPanel ───────────────────────────────────────────────────────────────

export function TracesPanel() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionTraces = useSessionStore((s) => s.sessionTraces);
  const addOrUpdateTraceSpan = useSessionStore((s) => s.addOrUpdateTraceSpan);
  const [loading, setLoading] = useState(false);

  const traces = activeSessionId ? (sessionTraces[activeSessionId] ?? []) : [];
  const turns = [...traces.filter((s) => s.type === "turn")].reverse();

  // Hydrate historical spans from main process on mount / session change
  const hydrate = useCallback(async () => {
    if (!activeSessionId) return;
    setLoading(true);
    try {
      const spans = await ipc.getTraces(activeSessionId);
      spans.forEach((span) => addOrUpdateTraceSpan(span));
    } catch {
      // Non-critical — live spans still flow via SESSION_TRACE push events
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, addOrUpdateTraceSpan]);

  useEffect(() => { void hydrate(); }, [hydrate]);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-2 flex flex-col gap-1.5">
        {loading && turns.length === 0 && (
          <div className="flex items-center gap-2 p-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            <span className="text-xs">Loading traces…</span>
          </div>
        )}

        {!loading && turns.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
            <Activity className="h-7 w-7 opacity-30" />
            <p className="text-xs text-center">
              No traces yet. Send a message to see<br />agent turn and tool call timings.
            </p>
          </div>
        )}

        {turns.map((turn) => (
          <TurnCard
            key={turn.id}
            turn={turn}
            tools={traces.filter((s) => s.parentId === turn.id)}
          />
        ))}
      </div>
    </div>
  );
}
