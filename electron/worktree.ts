import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import { buildChildProcessPath } from "./config";

const DEFAULT_BRANCH_PREFIX = "aichemist";
const DEFAULT_WORKTREE_PREFIX = "aichemist";

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: buildChildProcessPath(process.env.PATH) };
}

function normalizeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 40);
  return slug || "session";
}

function worktreeBranch(sessionId: string, attempt: number): string {
  const slug = normalizeSlug(sessionId);
  return attempt === 0
    ? `${DEFAULT_BRANCH_PREFIX}/${slug}`
    : `${DEFAULT_BRANCH_PREFIX}/${slug}-${attempt + 1}`;
}

function worktreeFolderName(sessionId: string, attempt: number): string {
  const slug = normalizeSlug(sessionId);
  return attempt === 0
    ? `${DEFAULT_WORKTREE_PREFIX}-${slug}`
    : `${DEFAULT_WORKTREE_PREFIX}-${slug}-${attempt + 1}`;
}

export interface ManagedWorktreePlan {
  repoRoot: string;
  managedRoot: string;
  branch: string;
  workspacePath: string;
}

export interface ManagedWorktreeResult extends ManagedWorktreePlan {
  created: boolean;
  warning?: string;
}

export interface ManagedWorktreeCleanup {
  repoRoot: string;
  workspacePath: string;
  branch: string;
}

export function resolveManagedWorktreeRoot(
  projectPath: string,
  configuredRoot?: string | null
): { managedRoot: string; warning?: string } {
  const fallback = path.dirname(projectPath);
  if (!configuredRoot) {
    return { managedRoot: fallback };
  }

  const resolved = path.resolve(configuredRoot);
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return {
        managedRoot: fallback,
        warning: `Invalid worktree root path "${configuredRoot}". Using ${fallback} instead.`,
      };
    }
    return { managedRoot: resolved };
  } catch {
    return {
      managedRoot: fallback,
      warning: `Invalid worktree root path "${configuredRoot}". Using ${fallback} instead.`,
    };
  }
}

export function isGitRepo(repoRoot: string): boolean {
  const result = childProcess.spawnSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    env: childEnv(),
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

export function createManagedWorktree(
  repoRoot: string,
  sessionId: string,
  managedRoot: string
): ManagedWorktreeResult {
  fs.mkdirSync(managedRoot, { recursive: true });

  const maxAttempts = 4;
  let lastWarning: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const branch = worktreeBranch(sessionId, attempt);
    const workspacePath = path.join(managedRoot, worktreeFolderName(sessionId, attempt));

    try {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    } catch {
      // Ignore pre-existing path cleanup failures — git will report the real error below.
    }

    const result = childProcess.spawnSync(
      "git",
      ["-C", repoRoot, "worktree", "add", "-b", branch, workspacePath],
      {
        encoding: "utf8",
        env: childEnv(),
      }
    );

    if (result.status === 0) {
      return { repoRoot, managedRoot, branch, workspacePath, created: true };
    }

    lastWarning = [result.stderr, result.stdout].filter(Boolean).join("").trim() || "git worktree add failed";

    try {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  return {
    repoRoot,
    managedRoot,
    branch: "",
    workspacePath: repoRoot,
    created: false,
    warning: lastWarning,
  };
}

export function cleanupManagedWorktree({ repoRoot, workspacePath, branch }: ManagedWorktreeCleanup): void {
  const env = childEnv();

  const remove = childProcess.spawnSync(
    "git",
    ["-C", repoRoot, "worktree", "remove", "--force", workspacePath],
    { encoding: "utf8", env }
  );
  if (remove.status !== 0) {
    throw new Error([remove.stderr, remove.stdout].filter(Boolean).join("").trim() || "Failed to remove worktree");
  }

  const prune = childProcess.spawnSync("git", ["-C", repoRoot, "worktree", "prune"], {
    encoding: "utf8",
    env,
  });
  if (prune.status !== 0) {
    throw new Error([prune.stderr, prune.stdout].filter(Boolean).join("").trim() || "Failed to prune worktree metadata");
  }

  const deleteBranch = childProcess.spawnSync(
    "git",
    ["-C", repoRoot, "branch", "-D", branch],
    { encoding: "utf8", env }
  );
  if (deleteBranch.status !== 0) {
    throw new Error([deleteBranch.stderr, deleteBranch.stdout].filter(Boolean).join("").trim() || "Failed to delete branch");
  }
}
