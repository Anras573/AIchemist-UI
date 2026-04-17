import { useEffect, useCallback, useState } from "react";
import { Activity, ChevronDown, Loader2, Wrench, Brain, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIpc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";
import type { TraceSpan } from "@/types";
import { Task, TaskTrigger, TaskContent } from "@/components/ai-elements/task";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "…";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

interface Tokens { input: number; output: number; cacheRead: number; cacheCreation: number }

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

function TurnCard({
  turn,
  tools,
  subTurns,
  allSpans,
}: {
  turn: TraceSpan;
  tools: TraceSpan[];
  subTurns: TraceSpan[];
  allSpans: TraceSpan[];
}) {
  const turnDuration = turn.durationMs ?? (turn.endMs ? undefined : Date.now() - turn.startMs);
  const meta = (turn.meta ?? {}) as Record<string, unknown>;
  const tokens = meta.tokens as Tokens | undefined;
  const model = meta.model as string | undefined;
  const thinking = meta.thinking as string | undefined;
  const isSidechain = !!meta.isSidechain;

  const hasContent = tools.length > 0 || !!thinking || subTurns.length > 0;

  return (
    <Task
      defaultOpen={false}
      className={cn(
        "rounded-md border bg-card text-card-foreground text-xs",
        isSidechain && "border-dashed border-primary/40"
      )}
    >
      <TaskTrigger title={turn.name}>
        <div className="flex items-center gap-2 w-full px-2.5 py-2 hover:bg-muted/40 transition-colors rounded-md">
          <StatusDot status={turn.status} />
          <span className="flex-1 font-medium text-left truncate">
            {isSidechain && <span className="text-primary/70 mr-1">↳</span>}
            {turn.name}
          </span>
          {model && (
            <span className="hidden sm:inline text-[10px] font-mono text-muted-foreground/80 shrink-0">
              {model.replace(/^claude-/, "")}
            </span>
          )}
          {tokens && (tokens.input > 0 || tokens.output > 0) && (
            <span className="text-[10px] tabular-nums text-muted-foreground shrink-0" title={
              `input: ${tokens.input}\noutput: ${tokens.output}\ncache read: ${tokens.cacheRead}\ncache write: ${tokens.cacheCreation}`
            }>
              ↓{formatTokens(tokens.input + tokens.cacheRead + tokens.cacheCreation)} ↑{formatTokens(tokens.output)}
            </span>
          )}
          {tools.length > 0 && (
            <span className="text-muted-foreground shrink-0">
              {tools.length} tool{tools.length !== 1 ? "s" : ""}
            </span>
          )}
          <span className="text-muted-foreground shrink-0 tabular-nums">
            {formatDuration(turnDuration)}
          </span>
          {hasContent && (
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          )}
        </div>
      </TaskTrigger>

      {hasContent && (
        <TaskContent>
          {thinking && <ThinkingBlock text={thinking} />}
          {tools.map((tool) => {
            const nestedSubs = allSpans.filter(
              (s) => s.type === "turn" && s.parentId === tool.id
            );
            return (
              <ToolRow
                key={tool.id}
                tool={tool}
                turnStartMs={turn.startMs}
                turnDuration={turn.durationMs}
                subTurns={nestedSubs}
                allSpans={allSpans}
              />
            );
          })}
          {subTurns.length > 0 && (
            <div className="pl-4 border-l border-primary/20 ml-2 my-1 flex flex-col gap-1">
              {subTurns.map((st) => {
                const stTools = allSpans.filter((s) => s.type === "tool" && s.parentId === st.id);
                const stSubs = allSpans.filter(
                  (s) => s.type === "turn" && s.parentId === st.id
                );
                return (
                  <TurnCard
                    key={st.id}
                    turn={st}
                    tools={stTools}
                    subTurns={stSubs}
                    allSpans={allSpans}
                  />
                );
              })}
            </div>
          )}
        </TaskContent>
      )}
    </Task>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-2.5 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain className="h-3 w-3" />
        <span>{open ? "Hide" : "Show"} thinking</span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <pre className="mt-1 text-[10px] whitespace-pre-wrap break-words text-foreground/70 bg-muted/40 rounded px-2 py-1.5 max-h-48 overflow-y-auto">
          {text}
        </pre>
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
  if (name === "Skill" || name === "Agent") {
    const skillName = (input.name ?? input.skill) as string | undefined;
    return skillName ? `${name.toLowerCase()}: ${skillName}` : null;
  }
  return null;
}

function ToolRow({
  tool,
  turnStartMs,
  turnDuration,
  subTurns,
  allSpans,
}: {
  tool: TraceSpan;
  turnStartMs: number;
  turnDuration: number | undefined;
  subTurns?: TraceSpan[];
  allSpans?: TraceSpan[];
}) {
  const [expanded, setExpanded] = useState(false);
  const offset = tool.startMs - turnStartMs;
  const duration = tool.durationMs ?? 0;
  const totalMs = turnDuration ?? Math.max(duration + offset, 1);

  const leftPct = Math.min((offset / totalMs) * 100, 95);
  const widthPct = Math.max((duration / totalMs) * 100, 1);

  const meta = (tool.meta ?? {}) as Record<string, unknown>;
  const toolResult = meta.toolResult as { preview: string; isError: boolean } | undefined;
  const hasDetail = !!toolResult || (subTurns && subTurns.length > 0);

  return (
    <div className="px-2.5 py-1.5 flex flex-col gap-1">
      {/* Name + status + duration */}
      <div
        className={cn("flex items-center gap-2", hasDetail && "cursor-pointer")}
        onClick={() => hasDetail && setExpanded((e) => !e)}
      >
        <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="flex-1 font-mono truncate text-muted-foreground">{tool.name}</span>
        {toolResult?.isError && <AlertCircle className="h-3 w-3 text-destructive shrink-0" />}
        <StatusDot status={tool.status} />
        <span className="tabular-nums text-muted-foreground shrink-0">
          {formatDuration(tool.durationMs)}
        </span>
        {hasDetail && (
          <ChevronDown className={cn("h-3 w-3 text-muted-foreground shrink-0 transition-transform", expanded && "rotate-180")} />
        )}
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
      {expanded && toolResult && (
        <pre
          className={cn(
            "mt-1 text-[10px] whitespace-pre-wrap break-words rounded px-2 py-1.5 max-h-40 overflow-y-auto ml-5",
            toolResult.isError
              ? "bg-destructive/10 text-destructive ring-1 ring-destructive/40"
              : "bg-muted/40 text-foreground/70"
          )}
        >
          {toolResult.preview}
        </pre>
      )}
      {expanded && subTurns && subTurns.length > 0 && allSpans && (
        <div className="pl-4 border-l border-primary/20 ml-2 my-1 flex flex-col gap-1">
          {subTurns.map((st) => {
            const stTools = allSpans.filter((s) => s.type === "tool" && s.parentId === st.id);
            const stSubs = allSpans.filter((s) => s.type === "turn" && s.parentId === st.id);
            return (
              <TurnCard
                key={st.id}
                turn={st}
                tools={stTools}
                subTurns={stSubs}
                allSpans={allSpans}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── TracesPanel ───────────────────────────────────────────────────────────────

export function TracesPanel() {
  const ipc = useIpc();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionTraces = useSessionStore((s) => s.sessionTraces);
  const addOrUpdateTraceSpan = useSessionStore((s) => s.addOrUpdateTraceSpan);
  const [loading, setLoading] = useState(false);

  const traces = activeSessionId ? (sessionTraces[activeSessionId] ?? []) : [];
  // Root turns = turns without a parentId (sidechain turns get nested under tools).
  const rootTurns = [...traces.filter((s) => s.type === "turn" && !s.parentId)].reverse();

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

  // Bind / unbind transcript watcher when session changes.
  useEffect(() => {
    if (!activeSessionId) return;
    const sid = activeSessionId;
    void ipc.bindTranscript(sid);
    return () => {
      void ipc.unbindTranscript(sid);
    };
  }, [activeSessionId, ipc]);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-2 flex flex-col gap-1.5">
        {loading && rootTurns.length === 0 && (
          <div className="flex items-center gap-2 p-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            <span className="text-xs">Loading traces…</span>
          </div>
        )}

        {!loading && rootTurns.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
            <Activity className="h-7 w-7 opacity-30" />
            <p className="text-xs text-center">
              No traces yet. Send a message to see<br />agent turn and tool call timings.
            </p>
          </div>
        )}

        {rootTurns.map((turn) => {
          const tools = traces.filter((s) => s.type === "tool" && s.parentId === turn.id);
          const subTurns = traces.filter((s) => s.type === "turn" && s.parentId === turn.id);
          return (
            <TurnCard
              key={turn.id}
              turn={turn}
              tools={tools}
              subTurns={subTurns}
              allSpans={traces}
            />
          );
        })}
      </div>
    </div>
  );
}
