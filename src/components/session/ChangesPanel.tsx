import { useState, useCallback, useEffect, type FormEvent } from "react";
import {
  RefreshCw,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  Loader2,
  ExternalLink,
  CheckCircle2,
} from "lucide-react";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useIpc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { FileChange } from "@/types";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// ── countDiffStats ────────────────────────────────────────────────────────────

function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function DiffStats({ diff }: { diff: string }) {
  const { added, removed } = countDiffStats(diff);
  if (added === 0 && removed === 0) return null;
  return (
    <span className="flex items-center gap-1 shrink-0 font-sans font-medium text-[11px]">
      {added > 0 && <span className="text-green-400">+{added}</span>}
      {removed > 0 && <span className="text-red-400">-{removed}</span>}
    </span>
  );
}

// ── CollapsibleChange ─────────────────────────────────────────────────────────

function CollapsibleChange({ change }: { change: FileChange }) {
  const [open, setOpen] = useState(false);

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
        {!change.isBinary && <DiffStats diff={change.diff} />}
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
        <div className="border-t">
          {change.isBinary ? (
            <p className="text-xs text-muted-foreground italic px-3 py-2">
              Binary file — diff not available.
            </p>
          ) : (
            <CodeBlock code={change.diff} language="diff" />
          )}
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

function GitFileDiff({ entry, projectPath }: { entry: GitFileEntry; projectPath: string }) {
  const ipc = useIpc();
  const [open, setOpen] = useState(false);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const handleToggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && entry.isUntracked && fileContent === null && fileError === null) {
      const result = await ipc.readFile(`${projectPath}/${entry.relativePath}`);
      if ("content" in result) {
        setFileContent(result.content);
      } else {
        setFileError(result.error);
      }
    }
  }, [open, entry, projectPath, fileContent, fileError]);

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/40 hover:bg-muted/70 transition-colors text-left text-xs font-mono"
        onClick={handleToggle}
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate flex-1 text-foreground">{entry.relativePath}</span>
        {!entry.isUntracked && <DiffStats diff={entry.diff} />}
        {entry.isUntracked && fileContent !== null && (
          <DiffStats diff={fileContent.split("\n").map((l) => `+${l}`).join("\n")} />
        )}
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded font-sans font-medium shrink-0",
            entry.isUntracked
              ? "bg-yellow-900/50 text-yellow-300"
              : "bg-blue-900/50 text-blue-300"
          )}
        >
          {entry.isUntracked ? "new file" : "modified"}
        </span>
      </button>
      {open && (
        <div className="border-t">
          {entry.isUntracked ? (
            fileError ? (
              <p className="text-xs text-red-400 px-3 py-2">{fileError}</p>
            ) : fileContent === null ? (
              <p className="text-xs text-muted-foreground italic px-3 py-2">Loading…</p>
            ) : (
              <CodeBlock
                code={fileContent.split("\n").map((l) => `+${l}`).join("\n")}
                language="diff"
              />
            )
          ) : (
            <CodeBlock code={entry.diff} language="diff" />
          )}
        </div>
      )}
    </div>
  );
}

// ── GitDiffSection ─────────────────────────────────────────────────────────────

function GitDiffSection({ projectPath }: { projectPath: string }) {
  const ipc = useIpc();
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
              <GitFileDiff key={i} entry={entry} projectPath={projectPath} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

function OpenPrSection({
  projectPath,
  sessionTitle,
}: {
  projectPath: string;
  sessionTitle: string | null;
}) {
  const ipc = useIpc();

  const [isChecking, setIsChecking] = useState(true);
  const [hasGitHubToken, setHasGitHubToken] = useState(false);
  const [hasGitHubRemote, setHasGitHubRemote] = useState(false);
  const [defaultBaseBranch, setDefaultBaseBranch] = useState<string | null>(null);
  const [defaultHeadBranch, setDefaultHeadBranch] = useState<string | null>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdPrUrl, setCreatedPrUrl] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsChecking(true);

    void (async () => {
      try {
        const token = await ipc.getApiKey("github");
        if (cancelled) return;
        const hasToken = Boolean(token);
        setHasGitHubToken(hasToken);

        if (!hasToken) {
          setHasGitHubRemote(false);
          setDefaultBaseBranch(null);
          setDefaultHeadBranch(null);
          return;
        }

        const [context, currentBranch] = await Promise.all([
          ipc.githubGetPrContext({ projectPath }),
          ipc.getGitBranch(projectPath),
        ]);
        if (cancelled) return;
        setHasGitHubRemote(context.hasRemote);
        setDefaultBaseBranch(context.defaultBase);
        setDefaultHeadBranch(currentBranch);
      } catch {
        if (cancelled) return;
        setHasGitHubToken(false);
        setHasGitHubRemote(false);
        setDefaultBaseBranch(null);
        setDefaultHeadBranch(null);
      } finally {
        if (!cancelled) setIsChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ipc, projectPath]);

  useEffect(() => {
    if (!successToast) return;
    const timeout = window.setTimeout(() => setSuccessToast(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [successToast]);

  const visible = !isChecking && hasGitHubToken && hasGitHubRemote;
  if (!visible) return null;

  const openForm = () => {
    setTitle(sessionTitle ?? "");
    setBase(defaultBaseBranch ?? "");
    setHead(defaultHeadBranch ?? "");
    setDescription("");
    setError(null);
    setCreatedPrUrl(null);
    setIsOpen(true);
  };

  const closeForm = () => {
    setIsOpen(false);
    setIsSubmitting(false);
  };

  const canSubmit = title.trim().length > 0 && head.trim().length > 0 && !isSubmitting;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setCreatedPrUrl(null);
    setIsSubmitting(true);

    try {
      const result = await ipc.githubCreatePr({
        projectPath,
        title: title.trim(),
        body: description.trim() ? description.trim() : undefined,
        head: head.trim(),
        base: base.trim() ? base.trim() : undefined,
      });

      if ("error" in result) {
        setError(result.error);
        return;
      }

      setCreatedPrUrl(result.pr.html_url);
      setSuccessToast(`Pull request #${result.pr.number} created`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSubmitting(false);
    }
  };

  const openCreatedPr = async () => {
    if (!createdPrUrl) return;
    try {
      await ipc.openGitHubUrl(createdPrUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Pull Request
        </span>
      </div>

      {!isOpen ? (
        <Button
          variant="outline"
          size="sm"
          onClick={openForm}
          className="self-start"
          aria-label="Open PR form"
        >
          <GitPullRequest className="h-3.5 w-3.5" />
          Open PR
        </Button>
      ) : (
        <form className="flex flex-col gap-2 border rounded-md p-3 bg-muted/20" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Title</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="PR title" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Base branch</span>
              <Input
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="Auto-detect if empty"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Head branch</span>
              <Input value={head} onChange={(e) => setHead(e.target.value)} placeholder="feature-branch" />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Description</span>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional PR description"
            />
          </div>

          {!head.trim() && (
            <p className="text-xs text-amber-300">
              Could not detect the current branch. Enter the head branch to continue.
            </p>
          )}

          {error && <p className="text-xs text-red-400 bg-red-950/30 rounded px-2 py-1">{error}</p>}

          {createdPrUrl && (
            <div className="text-xs rounded border border-emerald-800/60 bg-emerald-950/25 px-2 py-1.5 flex items-center justify-between gap-2">
              <span className="truncate text-emerald-300">{createdPrUrl}</span>
              <button
                type="button"
                onClick={openCreatedPr}
                className="inline-flex items-center gap-1 text-emerald-200 hover:text-emerald-100 underline underline-offset-2"
              >
                Open
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {isSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create PR"
              )}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={closeForm}>
              Close
            </Button>
          </div>
        </form>
      )}

      {successToast && (
        <div className="fixed right-4 bottom-4 z-50 px-3 py-2 text-xs rounded-md bg-emerald-950 text-emerald-100 border border-emerald-800 shadow-lg flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {successToast}
        </div>
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
  const activeSessionTitle = activeSession?.title ?? null;

  const changes: FileChange[] = activeSessionId
    ? (sessionFileChanges[activeSessionId] ?? [])
    : [];

  return (
    <div className="relative flex flex-col gap-4 p-3 overflow-y-auto h-full text-sm">
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

      {activeProject?.path ? (
        <>
          <div className="border-t" />
          <OpenPrSection
            projectPath={activeProject.path}
            sessionTitle={activeSessionTitle}
          />
        </>
      ) : null}
    </div>
  );
}
