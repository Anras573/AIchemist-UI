import { useEffect, useState, useCallback, useRef } from "react";
import { RefreshCw, GitBranch, Tag, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIpc } from "@/lib/ipc";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useActiveSessionProvider } from "@/lib/hooks/useActiveSessionProvider";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { Badge } from "@/components/ui/badge";
import type { GitHubPR, GitHubIssue } from "@/types";

interface GitHubPanelProps {}

interface GitHubData {
  prs: GitHubPR[];
  issues: GitHubIssue[];
}

type CiBadgeState = "success" | "failure" | "pending" | "unknown";

interface CiBadgeEntry {
  state: CiBadgeState;
  error?: string;
}

const CI_BADGE_META: Record<
  CiBadgeState,
  { label: string; symbol: string; className: string }
> = {
  success: {
    label: "passing",
    symbol: "✓",
    className:
      "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  failure: {
    label: "failing",
    symbol: "✗",
    className:
      "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  pending: {
    label: "pending",
    symbol: "●",
    className:
      "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  unknown: {
    label: "unknown",
    symbol: "—",
    className:
      "border-border bg-muted text-muted-foreground",
  },
};

function isGitHubProvider(
  provider: string | null
): provider is "anthropic" | "copilot" | "openai-compatible" | null {
  return (
    provider === null ||
    provider === "anthropic" ||
    provider === "copilot" ||
    provider === "openai-compatible"
  );
}

function normalizeCiState(rawState: string | undefined): CiBadgeState {
  switch (rawState) {
    case "success":
    case "failure":
    case "pending":
    case "unknown":
      return rawState;
    default:
      return "unknown";
  }
}

function getCiCacheKey(pr: Pick<GitHubPR, "head_sha" | "number">): string {
  const headSha = pr.head_sha?.trim();
  return headSha ? headSha : `pr:${pr.number}`;
}

function mapGitHubError(rawError: unknown): string {
  const message = String(rawError).replace(/^Error:\s*/, "").trim();
  if (!message) return "Failed to load GitHub data.";

  if (message.includes("no-github-remote")) {
    return "No GitHub remote found for this project. Add an origin remote and try again.";
  }
  if (message.includes("GITHUB_TOKEN not configured")) {
    return "GitHub token is not configured. Set GITHUB_TOKEN in ~/.aichemist/.env.";
  }
  if (message.includes("GitHub token is invalid or expired")) {
    return "GitHub token is invalid or expired. Update GITHUB_TOKEN and try again.";
  }
  if (/forbidden/i.test(message)) {
    return "Access to this GitHub repository was denied. Check your token permissions.";
  }
  if (/not found/i.test(message)) {
    return "GitHub repository not found. Check the configured remote and your access.";
  }
  if (message.includes("Invalid URL")) {
    return "Could not open the GitHub link because the URL is invalid.";
  }
  if (message.includes("Only GitHub HTTPS URLs can be opened")) {
    return "Only GitHub HTTPS URLs can be opened.";
  }

  return message;
}

/**
 * Lists open GitHub PRs and issues for the project's repository.
 * Fetches on mount and provides a refresh button.
 * Shows "not available" placeholder for non-GitHub sessions.
 */
export function GitHubPanel({}: GitHubPanelProps) {
  const ipc = useIpc();
  const { projects, activeProjectId } = useProjectStore();
  const { sessions, activeSessionId } = useSessionStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const projectPath = activeSession?.workspace_path ?? activeProject?.path ?? "";
  const provider = useActiveSessionProvider();
  const githubAvailable = isGitHubProvider(provider);
  const [data, setData] = useState<GitHubData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ciByKey, setCiByKey] = useState<Record<string, CiBadgeEntry>>({});
  const [ciLoadingByKey, setCiLoadingByKey] = useState<Record<string, boolean>>({});
  const requestIdRef = useRef(0);
  const ciGenerationRef = useRef(0);
  const ciRequestIdRef = useRef(0);
  const ciLatestRequestByKeyRef = useRef<Record<string, number>>({});

  const resetCiState = useCallback(() => {
    ciGenerationRef.current += 1;
    ciLatestRequestByKeyRef.current = {};
    setCiByKey({});
    setCiLoadingByKey({});
  }, []);

  const fetchCiStatus = useCallback(
    async (pr: GitHubPR, options?: { force?: boolean }) => {
      if (!projectPath || !githubAvailable) return;

      const key = getCiCacheKey(pr);
      if (!options?.force && (ciByKey[key] || ciLoadingByKey[key])) return;

      const generation = ciGenerationRef.current;
      const requestId = ++ciRequestIdRef.current;
      ciLatestRequestByKeyRef.current[key] = requestId;
      setCiLoadingByKey((prev) => ({ ...prev, [key]: true }));

      try {
        const result = await ipc.githubGetCiStatus(
          pr.head_sha
            ? { projectPath, ref: pr.head_sha }
            : { projectPath, prNumber: pr.number }
        );

        if (
          generation !== ciGenerationRef.current ||
          ciLatestRequestByKeyRef.current[key] !== requestId
        ) {
          return;
        }

        const nextEntry: CiBadgeEntry =
          "status" in result
            ? { state: normalizeCiState(result.status.state) }
            : { state: "unknown", error: mapGitHubError(result.error) };
        setCiByKey((prev) => ({ ...prev, [key]: nextEntry }));
      } catch (err) {
        if (
          generation !== ciGenerationRef.current ||
          ciLatestRequestByKeyRef.current[key] !== requestId
        ) {
          return;
        }

        setCiByKey((prev) => ({
          ...prev,
          [key]: { state: "unknown", error: mapGitHubError(err) },
        }));
      } finally {
        if (
          generation !== ciGenerationRef.current ||
          ciLatestRequestByKeyRef.current[key] !== requestId
        ) {
          return;
        }

        setCiLoadingByKey((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [projectPath, ciByKey, ciLoadingByKey, githubAvailable, ipc]
  );

  const fetchData = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!projectPath) return;
    if (!githubAvailable) return;

    setData(null);
    setIsLoading(true);
    setError(null);
    resetCiState();

    try {
      const [prsResult, issuesResult] = await Promise.all([
        ipc.githubListPrs({ projectPath, state: "open" }),
        ipc.githubListIssues({ projectPath, state: "open" }),
      ]);

      if (requestId !== requestIdRef.current) return;

      const prs = "error" in prsResult ? [] : prsResult.prs;
      const issues = "error" in issuesResult ? [] : issuesResult.issues;

      if ("error" in prsResult || "error" in issuesResult) {
        const fetchError =
          "error" in prsResult
            ? prsResult.error
            : "error" in issuesResult
              ? issuesResult.error
              : "Unknown error";
        setError(mapGitHubError(fetchError));
      }

      setData({ prs, issues });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(mapGitHubError(err));
    } finally {
      if (requestId !== requestIdRef.current) return;
      setIsLoading(false);
    }
  }, [projectPath, githubAvailable, ipc, resetCiState]);

  const openGitHubUrl = useCallback(
    async (url: string) => {
      try {
        await ipc.openGitHubUrl(url);
      } catch (err) {
        setError(mapGitHubError(err));
      }
    },
    [ipc]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!data?.prs.length || !githubAvailable) return;

    data.prs.forEach((pr) => {
      const key = getCiCacheKey(pr);
      if (ciByKey[key] || ciLoadingByKey[key]) return;
      void fetchCiStatus(pr);
    });
  }, [ciByKey, ciLoadingByKey, data?.prs, fetchCiStatus, githubAvailable]);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
      ciGenerationRef.current += 1;
    };
  }, []);

  if (!githubAvailable) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground text-xs px-3 text-center">
        <GitBranch className="h-8 w-8 opacity-30" />
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
            {data.prs.map((pr) => {
              const ciKey = getCiCacheKey(pr);
              const ciEntry = ciByKey[ciKey] ?? { state: "unknown" as const };
              const ciMeta = CI_BADGE_META[ciEntry.state];
              const ciLoading = ciLoadingByKey[ciKey] ?? false;
              const ciLabel = ciEntry.error
                ? `CI ${ciMeta.label}: ${ciEntry.error}`
                : `CI ${ciMeta.label}`;

              return (
                <div
                  key={pr.id}
                  className="w-full p-2.5 rounded-sm border border-transparent hover:border-border hover:bg-muted/50 transition-all group"
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void openGitHubUrl(pr.html_url);
                      }}
                      className="min-w-0 flex-1 text-left"
                      aria-label={`Open pull request #${pr.number}: ${pr.title}`}
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
                    <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={cn("capitalize", ciMeta.className)}
                        aria-label={ciLabel}
                      >
                        <span aria-hidden="true">{ciMeta.symbol}</span>
                        <span>{ciMeta.label}</span>
                      </Badge>
                      <WithTooltip label={`Refresh CI status for PR #${pr.number}`}>
                        <button
                          type="button"
                          onClick={() => {
                            void fetchCiStatus(pr, { force: true });
                          }}
                          disabled={ciLoading}
                          className="flex items-center justify-center h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                          aria-label={`Refresh CI status for PR #${pr.number}`}
                        >
                          <RefreshCw className={cn("h-3.5 w-3.5", ciLoading && "animate-spin")} />
                        </button>
                      </WithTooltip>
                    </div>
                  </div>
                </div>
              );
            })}
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
                type="button"
                onClick={() => {
                  void openGitHubUrl(issue.html_url);
                }}
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
