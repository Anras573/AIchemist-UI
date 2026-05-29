import { useState, useEffect, useMemo } from "react";
import { Hash } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { GitHubIssue } from "@/types";

interface IssueLinkPickerProps {
  projectPath: string;
  selectedNumber: number | null;
  onChange: (issueNumber: number | null) => void;
  className?: string;
}

/**
 * Searchable issue picker populated from GITHUB_LIST_ISSUES.
 * Renders nothing when GitHub is unavailable (no remote or no token).
 */
export function IssueLinkPicker({
  projectPath,
  selectedNumber,
  onChange,
  className,
}: IssueLinkPickerProps) {
  const ipc = useIpc();
  const [issues, setIssues] = useState<GitHubIssue[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    ipc.githubListIssues({ projectPath, state: "open", limit: 50 })
      .then((result) => {
        if (cancelled) return;
        if ("issues" in result) {
          setIssues(result.issues);
        } else {
          // No remote or no token — hide the picker
          setIssues(null);
        }
      })
      .catch(() => {
        if (!cancelled) setIssues(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    if (!issues) return [];
    const q = search.toLowerCase();
    if (!q) return issues;
    return issues.filter(
      (i) =>
        String(i.number).includes(q) ||
        i.title.toLowerCase().includes(q) ||
        i.labels?.some((l) => l.toLowerCase().includes(q))
    );
  }, [issues, search]);

  // Don't render if GitHub isn't available (loading still shown briefly to
  // avoid layout jumps, but hidden once we know it's unavailable).
  if (!loading && issues === null) return null;

  const selectedIssue = selectedNumber != null
    ? issues?.find((i) => i.number === selectedNumber) ?? null
    : null;

  return (
    <div className={cn("flex flex-col gap-1 w-full", className)}>
      <span className="text-xs text-muted-foreground font-medium">Link to issue (optional)</span>
      {loading ? (
        <div className="h-8 rounded border border-border bg-muted/40 animate-pulse" />
      ) : (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "w-full flex items-center gap-1.5 px-2 py-1.5 text-xs rounded border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors text-left",
              open && "ring-1 ring-ring"
            )}
            aria-haspopup="listbox"
            aria-expanded={open}
          >
            <Hash className="size-3 shrink-0 text-muted-foreground" />
            {selectedIssue ? (
              <span className="flex-1 truncate">
                <span className="text-muted-foreground mr-1">#{selectedIssue.number}</span>
                {selectedIssue.title}
              </span>
            ) : (
              <span className="flex-1 text-muted-foreground">None</span>
            )}
          </button>

          {open && (
            <div className="absolute z-50 mt-1 w-full bg-popover border border-border rounded shadow-md">
              <div className="p-1 border-b border-border">
                <input
                  autoFocus
                  type="text"
                  placeholder="Search issues…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full text-xs px-2 py-1 rounded bg-background border border-input focus:outline-none focus:ring-1 focus:ring-ring"
                  aria-label="Search issues"
                />
              </div>
              <ul
                role="listbox"
                aria-label="Issues"
                className="max-h-48 overflow-y-auto py-1"
              >
                <li
                  role="option"
                  aria-selected={selectedNumber === null}
                  tabIndex={0}
                  onClick={() => { onChange(null); setOpen(false); setSearch(""); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onChange(null);
                      setOpen(false);
                      setSearch("");
                    }
                  }}
                  className={cn(
                    "px-2 py-1.5 text-xs cursor-pointer hover:bg-accent hover:text-accent-foreground",
                    selectedNumber === null && "bg-accent/50"
                  )}
                >
                  <span className="text-muted-foreground">None</span>
                </li>
                {filtered.map((issue) => (
                  <li
                    key={issue.number}
                    role="option"
                    aria-selected={issue.number === selectedNumber}
                    tabIndex={0}
                    onClick={() => { onChange(issue.number); setOpen(false); setSearch(""); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onChange(issue.number);
                        setOpen(false);
                        setSearch("");
                      }
                    }}
                    className={cn(
                      "px-2 py-1.5 text-xs cursor-pointer hover:bg-accent hover:text-accent-foreground",
                      issue.number === selectedNumber && "bg-accent/50"
                    )}
                  >
                    <span className="flex items-start gap-1.5 min-w-0">
                      <span className="text-muted-foreground shrink-0">#{issue.number}</span>
                      <span className="truncate flex-1">{issue.title}</span>
                      {issue.labels?.slice(0, 3).map((label) => (
                        <span
                          key={label}
                          className="shrink-0 px-1 rounded text-[10px] bg-muted text-muted-foreground"
                        >
                          {label}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
                {filtered.length === 0 && (
                  <li className="px-2 py-1.5 text-xs text-muted-foreground">No issues found</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
