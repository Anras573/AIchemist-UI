import { execFileSync } from "child_process";
import { Octokit } from "@octokit/rest";
import { getApiKey } from "./config";

export interface GitHubRemoteInfo {
  owner: string;
  repo: string;
}

/**
 * Returns an authenticated Octokit client when GITHUB_TOKEN is configured.
 * Returns null when no token is available.
 */
export function createGitHubClient(
  token: string | null = getApiKey("github")
): Octokit | null {
  if (!token) return null;
  return new Octokit({ auth: token });
}

/**
 * Parse a GitHub remote URL into owner/repo.
 * Supports:
 * - https://github.com/owner/repo(.git)
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

  if (parsed.hostname.toLowerCase() !== "github.com") return null;

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

function resolveOriginRemoteUrl(projectPath: string): string {
  return execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: projectPath,
    encoding: "utf8",
  }).trim();
}

/**
 * Resolve { owner, repo } from `git remote get-url origin`.
 * Returns null when the origin is missing, malformed, or non-GitHub.
 */
export function getRemoteInfo(
  projectPath: string,
  readOriginRemoteUrl: (projectPath: string) => string = resolveOriginRemoteUrl
): GitHubRemoteInfo | null {
  try {
    const remoteUrl = readOriginRemoteUrl(projectPath);
    return parseGitHubRemoteUrl(remoteUrl);
  } catch {
    return null;
  }
}
