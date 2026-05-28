import { execFile } from "child_process";
import { delimiter } from "path";
import { promisify } from "util";
import { getApiKey, buildChildProcessPath } from "./config";
import type {
  GitHubCreatePrArgs,
  GitHubCreatePrResult,
  GitHubGetCiStatusArgs,
  GitHubGetCiStatusResult,
  GitHubGetPrContextArgs,
  GitHubGetPrContextResult,
  GitHubIssue,
  GitHubListIssuesArgs,
  GitHubListIssuesResult,
  GitHubListPrsArgs,
  GitHubListPrsResult,
  GitHubPR,
} from "../src/types/index";

const execFileAsync = promisify(execFile);

export interface GitHubRemoteInfo {
  owner: string;
  repo: string;
}

/**
 * Returns an authenticated Octokit client when GITHUB_TOKEN is configured.
 * Returns null when no token is available.
 */
export async function createGitHubClient(
  token: string | null = getApiKey("github")
) {
  if (!token) return null;
  const { Octokit } = await import("@octokit/rest");
  return new Octokit({ auth: token });
}

/**
 * Parse a GitHub remote URL into owner/repo.
 * Supports:
 * - https://github.com/owner/repo(.git)
 * - https://www.github.com/owner/repo(.git)
 * - git@github.com:owner/repo(.git)
 * - ssh://git@github.com/owner/repo(.git)
 */
export function parseGitHubRemoteUrl(remoteUrl: string): GitHubRemoteInfo | null {
  const normalized = remoteUrl.trim();
  if (!normalized) return null;

  const sshMatch = normalized.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i
  );
  if (sshMatch) {
    const owner = sshMatch[1]?.trim();
    const repo = sshMatch[2]?.trim();
    if (!owner || !repo) return null;
    return { owner, repo };
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "www.github.com") return null;

  const parts = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);

  if (parts.length !== 2) return null;

  const owner = parts[0];
  const repoRaw = parts[1];
  if (!owner || !repoRaw) return null;

  const repo = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;
  if (!repo) return null;

  return { owner, repo };
}

async function resolveOriginRemoteUrl(projectPath: string): Promise<string> {
  const env = {
    ...process.env,
    PATH: buildChildProcessPath(process.env.PATH, delimiter),
  };
  const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
    cwd: projectPath,
    encoding: "utf8",
    timeout: 5_000,
    env,
  });
  return stdout.trim();
}

/**
 * Resolve { owner, repo } from `git remote get-url origin`.
 * Returns null when the origin is missing, malformed, or non-GitHub.
 */
export async function getRemoteInfo(
  projectPath: string,
  readOriginRemoteUrl: (projectPath: string) => Promise<string> = resolveOriginRemoteUrl
): Promise<GitHubRemoteInfo | null> {
  try {
    const remoteUrl = await readOriginRemoteUrl(projectPath);
    return parseGitHubRemoteUrl(remoteUrl);
  } catch {
    return null;
  }
}

// ── GitHub REST operation helpers ─────────────────────────────────────────────

/** Opaque type for an authenticated Octokit client. */
export type OctokitClient = NonNullable<Awaited<ReturnType<typeof createGitHubClient>>>;

/**
 * Injectable test seams for the GitHub operation functions.
 * Pass these in unit tests to avoid spawning git or hitting the network.
 */
export interface GitHubTestDeps {
  /** Pre-resolved remote info; `null` simulates a non-GitHub remote. */
  remoteInfo?: GitHubRemoteInfo | null;
  /** Pre-built Octokit client; `null` simulates a missing token. */
  client?: OctokitClient | null;
  /** Override current branch detection; `null` simulates detached HEAD or git failure. */
  currentBranch?: string | null;
}

/**
 * Maps common Octokit HTTP errors to human-readable strings.
 * Returns `null` for unknown/non-HTTP errors; callers fall back to `String(err)`.
 */
function httpError(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const status = (err as Record<string, unknown>).status;
  if (typeof status !== "number") return null;
  const msg = (err as Record<string, unknown>).message;
  const detail = typeof msg === "string" ? msg : "";
  switch (status) {
    case 401:
      return "GitHub token is invalid or expired";
    case 403:
      return detail
        ? `Forbidden: ${detail}`
        : "Insufficient GitHub token scope — needs 'repo' for private or 'public_repo' for public repositories";
    case 404:
      return "Repository not found or private without 'repo' scope";
    case 422:
      return detail ? `Validation failed: ${detail}` : "Validation failed";
    default:
      return detail || `GitHub API error (HTTP ${status})`;
  }
}

/**
 * Aggregates check-run results into a single CI status string.
 * Order of precedence: pending > failure > success > unknown.
 */
export function aggregateCiStatus(
  checkRuns: Array<{ status: string; conclusion: string | null }>
): "success" | "failure" | "pending" | "unknown" {
  if (checkRuns.length === 0) return "unknown";

  if (checkRuns.some((r) => r.status === "in_progress" || r.status === "queued" || r.status === "waiting" || r.status === "requested" || r.status === "pending")) {
    return "pending";
  }

  const failConclusions = new Set(["failure", "timed_out", "cancelled", "action_required"]);
  if (checkRuns.some((r) => r.conclusion !== null && failConclusions.has(r.conclusion))) {
    return "failure";
  }

  const successConclusions = new Set(["success", "neutral", "skipped"]);
  if (
    checkRuns.every(
      (r) =>
        r.status === "completed" &&
        r.conclusion !== null &&
        successConclusions.has(r.conclusion)
    )
  ) {
    return "success";
  }

  return "unknown";
}

function aggregateLegacyCommitStatus(
  state: string | null | undefined
): "success" | "failure" | "pending" | "unknown" {
  switch (state) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
      return "pending";
    default:
      return "unknown";
  }
}

async function resolveContext(
  projectPath: string,
  deps: GitHubTestDeps | undefined
): Promise<{ error: string } | { client: OctokitClient; owner: string; repo: string }> {
  const remoteInfo =
    deps?.remoteInfo !== undefined ? deps.remoteInfo : await getRemoteInfo(projectPath);
  if (!remoteInfo) return { error: "no-github-remote" };

  const client =
    deps?.client !== undefined
      ? deps.client
      : await createGitHubClient(getApiKey("github"));
  if (!client) return { error: "GITHUB_TOKEN not configured" };

  return { client, owner: remoteInfo.owner, repo: remoteInfo.repo };
}

async function resolveCurrentBranch(projectPath: string): Promise<string | null> {
  const env = {
    ...process.env,
    PATH: buildChildProcessPath(process.env.PATH, delimiter),
  };
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: projectPath, encoding: "utf8", timeout: 5_000, env }
    );
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

function mapPr(pr: {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  draft?: boolean;
  created_at: string;
  updated_at: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user?: { login: string } | null;
}): GitHubPR {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    html_url: pr.html_url,
    draft: pr.draft,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    head_sha: pr.head.sha,
    head_ref: pr.head.ref,
    base_ref: pr.base.ref,
    author: pr.user?.login,
  };
}

// ── Exported operation functions ──────────────────────────────────────────────

export async function listPullRequests(
  args: GitHubListPrsArgs,
  _deps?: GitHubTestDeps
): Promise<GitHubListPrsResult> {
  const ctx = await resolveContext(args.projectPath, _deps);
  if ("error" in ctx) return ctx;
  const { client, owner, repo } = ctx;

  try {
    const response = await client.pulls.list({
      owner,
      repo,
      state: args.state ?? "open",
      base: args.base,
      head: args.head,
      per_page: typeof args.limit === "number" && args.limit > 0 ? Math.max(1, Math.min(Math.trunc(args.limit), 100)) : 30,
    });
    return { prs: response.data.map(mapPr) };
  } catch (err) {
    return { error: httpError(err) ?? String(err) };
  }
}

export async function listIssues(
  args: GitHubListIssuesArgs,
  _deps?: GitHubTestDeps
): Promise<GitHubListIssuesResult> {
  const ctx = await resolveContext(args.projectPath, _deps);
  if ("error" in ctx) return ctx;
  const { client, owner, repo } = ctx;

  try {
    const response = await client.issues.listForRepo({
      owner,
      repo,
      state: args.state ?? "open",
      labels: args.labels?.length ? args.labels.join(",") : undefined,
      per_page: typeof args.limit === "number" && args.limit > 0 ? Math.max(1, Math.min(Math.trunc(args.limit), 100)) : 30,
    });
    const issues: GitHubIssue[] = response.data
      .filter((issue) => !("pull_request" in issue && issue.pull_request))
      .map((issue) => {
        const labels = (issue.labels || [])
          .map((label) => {
            if (typeof label === "string") return label;
            if (typeof label?.name === "string") return label.name;
            return null;
          })
          .filter((l): l is string => l !== null)
          .slice(0, 20);

        return {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          state: issue.state,
          html_url: issue.html_url,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          ...(labels.length > 0 ? { labels } : {}),
        };
      });
    return { issues };
  } catch (err) {
    return { error: httpError(err) ?? String(err) };
  }
}

export async function getPullRequestContext(
  args: GitHubGetPrContextArgs,
  _deps?: Pick<GitHubTestDeps, "remoteInfo" | "client">
): Promise<GitHubGetPrContextResult> {
  const remoteInfo =
    _deps?.remoteInfo !== undefined ? _deps.remoteInfo : await getRemoteInfo(args.projectPath);
  if (!remoteInfo) return { hasRemote: false, defaultBase: null };

  const client =
    _deps?.client !== undefined
      ? _deps.client
      : await createGitHubClient(getApiKey("github"));
  if (!client) return { hasRemote: true, defaultBase: null };

  try {
    const repoInfo = await client.repos.get({ owner: remoteInfo.owner, repo: remoteInfo.repo });
    return { hasRemote: true, defaultBase: repoInfo.data.default_branch ?? null };
  } catch {
    return { hasRemote: true, defaultBase: null };
  }
}

export async function createPullRequest(
  args: GitHubCreatePrArgs,
  _deps?: GitHubTestDeps
): Promise<GitHubCreatePrResult> {
  const ctx = await resolveContext(args.projectPath, _deps);
  if ("error" in ctx) return ctx;
  const { client, owner, repo } = ctx;

  const head =
    args.head ??
    (_deps?.currentBranch !== undefined
      ? _deps.currentBranch
      : await resolveCurrentBranch(args.projectPath));
  if (!head) return { error: "Could not determine head branch — provide args.head explicitly" };

  let base = args.base;
  if (!base) {
    try {
      const repoInfo = await client.repos.get({ owner, repo });
      base = repoInfo.data.default_branch;
    } catch {
      base = "main";
    }
  }

  try {
    const response = await client.pulls.create({
      owner,
      repo,
      title: args.title,
      body: args.body,
      head,
      base,
      draft: args.draft,
    });
    return { pr: mapPr(response.data) };
  } catch (err) {
    return { error: httpError(err) ?? String(err) };
  }
}

export async function getCiStatus(
  args: GitHubGetCiStatusArgs,
  _deps?: GitHubTestDeps
): Promise<GitHubGetCiStatusResult> {
  const ctx = await resolveContext(args.projectPath, _deps);
  if ("error" in ctx) return ctx;
  const { client, owner, repo } = ctx;

  let resolvedRef: string;
  let refIsConfirmedSha = false;
  if (args.prNumber !== undefined) {
    try {
      const pr = await client.pulls.get({ owner, repo, pull_number: args.prNumber });
      resolvedRef = pr.data.head.sha;
      refIsConfirmedSha = true;
    } catch (err) {
      return { error: httpError(err) ?? String(err) };
    }
  } else if (args.ref) {
    resolvedRef = args.ref;
  } else {
    return { error: "ref or prNumber is required to check CI status" };
  }

  try {
    const response = await client.checks.listForRef({
      owner,
      repo,
      ref: resolvedRef,
      per_page: 100, // fetches first page only; repos with >100 check runs may return incomplete status
    });
    const checkRunState = aggregateCiStatus(
      response.data.check_runs.map((r) => ({
        status: r.status,
        conclusion: r.conclusion ?? null,
      }))
    );

    let state = checkRunState;
    if (state === "unknown" && response.data.check_runs.length === 0) {
      try {
        const combined = await client.repos.getCombinedStatusForRef({
          owner,
          repo,
          ref: resolvedRef,
        });
        state = aggregateLegacyCommitStatus(combined.data.state);
      } catch {
        state = checkRunState;
      }
    }

    return { status: { state, ...(refIsConfirmedSha ? { sha: resolvedRef } : {}) } };
  } catch (err) {
    return { error: httpError(err) ?? String(err) };
  }
}
