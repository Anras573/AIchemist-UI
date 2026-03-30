import { useState, useCallback } from "react";
import { RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { FileChange } from "@/types";

// ── DiffView ─────────────────────────────────────────────────────────────────

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");

  return (
    <pre className="text-xs font-mono leading-5 overflow-x-auto p-2">
      {lines.map((line, i) => {
        const isAdd = line.startsWith("+") && !line.startsWith("+++");
        const isDel = line.startsWith("-") && !line.startsWith("---");
        const isHunk = line.startsWith("@@");
        const isHeader = line.startsWith("---") || line.startsWith("+++");

        return (
          <div
            key={i}
            className={cn(
              "whitespace-pre",
              isAdd && "bg-green-950/50 text-green-400",
              isDel && "bg-red-950/50 text-red-400",
              isHunk && "text-blue-400",
              isHeader && "text-muted-foreground"
            )}
          >
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

// ── CollapsibleChange ─────────────────────────────────────────────────────────

function CollapsibleChange({ change }: { change: FileChange }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/40 hover:bg-muted/70 transition-colors text-left text-xs font-mono"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate flex-1 text-foreground">{change.relativePath}</span>
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded font-sans font-medium shrink-0",
            change.operation === "write"
              ? "bg-blue-900/50 text-blue-300"
              : "bg-red-900/50 text-red-300"
          )}
        >
          {change.operation === "write" ? "write" : "delete"}
        </span>
      </button>
      {open && (
        <div className="border-t overflow-x-auto">
          <DiffView diff={change.diff} />
        </div>
      )}
    </div>
  );
}

// ── parseGitDiff ──────────────────────────────────────────────────────────────

interface GitFileEntry {
  relativePath: string;
  diff: string;
  isUntracked: boolean;
}

function parseGitDiff(raw: string): GitFileEntry[] {
  const results: GitFileEntry[] = [];

  // Split off the untracked files footer added by our backend
  const UNTRACKED_HEADER = "=== Untracked files ===\n";
  const markerIdx = raw.indexOf(UNTRACKED_HEADER);
  const mainDiff = markerIdx >= 0 ? raw.slice(0, markerIdx) : raw;
  const untrackedSection = markerIdx >= 0 ? raw.slice(markerIdx + UNTRACKED_HEADER.length) : "";

  // Split tracked file chunks on "diff --git" boundaries
  const chunks = mainDiff.split(/(?=^diff --git )/m).filter(Boolean);
  for (const chunk of chunks) {
    const match = chunk.match(/^diff --git a\/.+? b\/(.+)/m);
    if (match) results.push({ relativePath: match[1].trim(), diff: chunk, isUntracked: false });
  }

  // Append untracked files (no diff content available)
  for (const line of untrackedSection.split("\n")) {
    if (line.trim()) results.push({ relativePath: line.trim(), diff: "", isUntracked: true });
  }

  return results;
}

// ── GitFileDiff ───────────────────────────────────────────────────────────────

function GitFileDiff({ entry }: { entry: GitFileEntry }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/40 hover:bg-muted/70 transition-colors text-left text-xs font-mono"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate flex-1 text-foreground">{entry.relativePath}</span>
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded font-sans font-medium shrink-0",
            entry.isUntracked
              ? "bg-yellow-900/50 text-yellow-300"
              : "bg-blue-900/50 text-blue-300"
          )}
        >
          {entry.isUntracked ? "untracked" : "modified"}
        </span>
      </button>
      {open && (
        <div className="border-t overflow-x-auto">
          {entry.isUntracked ? (
            <p className="text-xs text-muted-foreground italic px-3 py-2">
              New untracked file — not yet staged or committed.
            </p>
          ) : (
            <DiffView diff={entry.diff} />
          )}
        </div>
      )}
    </div>
  );
}

// ── GitDiffSection ─────────────────────────────────────────────────────────────

function GitDiffSection({ projectPath }: { projectPath: string }) {
  const [entries, setEntries] = useState<GitFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.getGitDiff(projectPath);
      if (typeof result === "string") {
        setEntries(parseGitDiff(result));
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Git Diff (working tree)
        </span>
        <button
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {entries === null && !error && (
        <p className="text-xs text-muted-foreground italic">Click Refresh to load git diff.</p>
      )}
      {error && (
        <p className="text-xs text-red-400 bg-red-950/30 rounded px-2 py-1">{error}</p>
      )}
      {entries !== null && !error && (
        entries.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No uncommitted changes.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {entries.map((entry, i) => (
              <GitFileDiff key={i} entry={entry} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

// ── ChangesPanel ──────────────────────────────────────────────────────────────

export function ChangesPanel() {
  const { sessions, activeSessionId, sessionFileChanges } = useSessionStore();
  const { activeProjectId, projects } = useProjectStore();
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const changes: FileChange[] = activeSessionId
    ? (sessionFileChanges[activeSessionId] ?? [])
    : [];

  return (
    <div className="flex flex-col gap-4 p-3 overflow-y-auto h-full text-sm">
      {/* Session writes */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Files written this session
        </span>
        {activeSession === null ? (
          <p className="text-xs text-muted-foreground italic">No active session.</p>
        ) : changes.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No file changes yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {changes.map((c, i) => (
              <CollapsibleChange key={i} change={c} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t" />

      {/* Git diff */}
      {activeProject?.path ? (
        <GitDiffSection projectPath={activeProject.path} />
      ) : (
        <p className="text-xs text-muted-foreground italic">No project path available for git diff.</p>
      )}
    </div>
  );
}
