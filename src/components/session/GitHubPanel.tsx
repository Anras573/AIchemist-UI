import { useEffect, useState, useCallback, useRef } from "react";
import { RefreshCw, GitBranch, Tag, ExternalLink, Github } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIpc } from "@/lib/ipc";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useActiveSessionProvider } from "@/lib/hooks/useActiveSessionProvider";
import { WithTooltip } from "@/components/ui/with-tooltip";
import type { GitHubPR, GitHubIssue } from "@/types";

interface GitHubPanelProps {}

interface GitHubData {
  prs: GitHubPR[];
  issues: GitHubIssue[];
}

/**
 * Lists open GitHub PRs and issues for the project's repository.
 * Fetches on mount and provides a refresh button.
 * Shows "not available" placeholder for ACP sessions.
 */
export function GitHubPanel({}: GitHubPanelProps) {
  const ipc = useIpc();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const provider = useActiveSessionProvider();
  const [data, setData] = useState<GitHubData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!activeProject) return;
    if (provider && provider !== "anthropic" && provider !== "copilot") return;

    setIsLoading(true);
    setError(null);

    try {
      const [prsResult, issuesResult] = await Promise.all([
        ipc.githubListPrs({ projectPath: activeProject.path, state: "open" }),
        ipc.githubListIssues({ projectPath: activeProject.path, state: "open" }),
      ]);

      if (requestId !== requestIdRef.current) return;

      const prs = "error" in prsResult ? [] : prsResult.prs;
      const issues = "error" in issuesResult ? [] : issuesResult.issues;

      if ("error" in prsResult || "error" in issuesResult) {
        setError(
          "error" in prsResult ? prsResult.error : "error" in issuesResult ? issuesResult.error : "Unknown error"
        );
      }

      setData({ prs, issues });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(String(err));
    } finally {
      if (requestId !== requestIdRef.current) return;
      setIsLoading(false);
    }
  }, [activeProject, ipc, provider]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (provider && provider !== "anthropic" && provider !== "copilot") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground text-xs px-3 text-center">
        <Github className="h-8 w-8 opacity-30" />
        <span>GitHub PRs and issues are not available for {provider} sessions.</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-3 text-center">
        <div className="text-xs text-destructive">{error}</div>
        <button
          onClick={fetchData}
          disabled={isLoading}
          className={cn(
            "px-2 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/80 transition-colors",
            isLoading && "opacity-50 cursor-not-allowed"
          )}
        >
          {isLoading ? "Loading..." : "Retry"}
        </button>
      </div>
    );
  }

  if (data === null || isLoading) {
    return (
      <div className="h-full overflow-y-auto py-2 px-3 space-y-4">
        {/* Skeleton PRs section */}
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Pull Requests
          </div>
          {[1, 2].map((i) => (
            <div key={i} className="animate-pulse space-y-2">
              <div className="h-4 bg-muted rounded w-3/4" />
              <div className="h-3 bg-muted rounded w-1/2" />
            </div>
          ))}
        </div>
        {/* Skeleton Issues section */}
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Issues
          </div>
          {[1, 2].map((i) => (
            <div key={`issue-${i}`} className="animate-pulse space-y-2">
              <div className="h-4 bg-muted rounded w-3/4" />
              <div className="h-3 bg-muted rounded w-1/2" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const hasPRs = data.prs.length > 0;
  const hasIssues = data.issues.length > 0;

  return (
    <div className="h-full overflow-y-auto py-2">
      {/* Refresh button in sticky header */}
      <div className="sticky top-0 bg-background z-10 px-3 pb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          GitHub
        </span>
        <WithTooltip label="Refresh">
          <button
            onClick={fetchData}
            disabled={isLoading}
            className="flex items-center justify-center h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          </button>
        </WithTooltip>
      </div>

      {/* PRs section */}
      <div className="px-3 py-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Pull Requests
        </div>
        {hasPRs ? (
          <div className="space-y-2">
            {data.prs.map((pr) => (
              <button
                key={pr.id}
                onClick={() => ipc.openGitHubUrl(pr.html_url)}
                className="w-full text-left p-2.5 rounded-sm border border-transparent hover:border-border hover:bg-muted/50 transition-all group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate group-hover:underline">
                      {pr.title}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap mt-1 text-xs text-muted-foreground">
                      {pr.author && (
                        <span>by {pr.author}</span>
                      )}
                      {pr.head_ref && (
                        <span className="inline-flex items-center gap-0.5">
                          <GitBranch className="h-3 w-3" />
                          {pr.head_ref}
                        </span>
                      )}
                      <span className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">
                        #{pr.number}
                      </span>
                    </div>
                  </div>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground py-2">No open pull requests</div>
        )}
      </div>

      {/* Issues section */}
      <div className="px-3 py-3 border-t">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Issues
        </div>
        {hasIssues ? (
          <div className="space-y-2">
            {data.issues.map((issue) => (
              <button
                key={issue.id}
                onClick={() => ipc.openGitHubUrl(issue.html_url)}
                className="w-full text-left p-2.5 rounded-sm border border-transparent hover:border-border hover:bg-muted/50 transition-all group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate group-hover:underline">
                      {issue.title}
                    </div>
                    <div className="flex items-center gap-1 flex-wrap mt-1">
                      {issue.labels && issue.labels.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap">
                          {issue.labels.map((label) => (
                            <span
                              key={label}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground"
                            >
                              <Tag className="h-2.5 w-2.5" />
                              {label}
                            </span>
                          ))}
                        </div>
                      )}
                      <span className="text-xs text-muted-foreground px-1.5 py-0.5 font-mono">
                        #{issue.number}
                      </span>
                    </div>
                  </div>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground py-2">No open issues</div>
        )}
      </div>
    </div>
  );
}
