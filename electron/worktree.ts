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
    : `${DEFAULT_BRANCH_PREFIX}/${slug}-${attempt}`;
}

function worktreeFolderName(sessionId: string, attempt: number): string {
  const slug = normalizeSlug(sessionId);
  return attempt === 0
    ? `${DEFAULT_WORKTREE_PREFIX}-${slug}`
    : `${DEFAULT_WORKTREE_PREFIX}-${slug}-${attempt}`;
}

function removeIfEmptyDirectory(targetPath: string): void {
  try {
    if (!fs.existsSync(targetPath)) {
      return;
    }
    if (!fs.statSync(targetPath).isDirectory()) {
      return;
    }
    if (fs.readdirSync(targetPath).length > 0) {
      return;
    }
    fs.rmSync(targetPath);
  } catch {
    // Best-effort cleanup only.
  }
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

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async git runner — never blocks the main process. Resolves (never rejects). */
function runGit(args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    childProcess.execFile(
      "git",
      args,
      { encoding: "utf8", env: childEnv(), maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ status: 0, stdout, stderr });
        const code = (err as NodeJS.ErrnoException).code;
        resolve({
          status: typeof code === "number" ? code : -1,
          stdout: stdout ?? "",
          stderr: stderr || (err instanceof Error ? err.message : String(err)),
        });
      }
    );
  });
}

export async function isGitRepo(repoRoot: string): Promise<boolean> {
  const result = await runGit(["-C", repoRoot, "rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

export async function createManagedWorktree(
  repoRoot: string,
  sessionId: string,
  managedRoot: string
): Promise<ManagedWorktreeResult> {
  fs.mkdirSync(managedRoot, { recursive: true });

  const maxAttempts = 4;
  let lastWarning: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const branch = worktreeBranch(sessionId, attempt);
    const workspacePath = path.join(managedRoot, worktreeFolderName(sessionId, attempt));

    removeIfEmptyDirectory(workspacePath);

    const result = await runGit(["-C", repoRoot, "worktree", "add", "-b", branch, workspacePath]);

    if (result.status === 0) {
      return { repoRoot, managedRoot, branch, workspacePath, created: true };
    }

    lastWarning = [result.stderr, result.stdout].filter(Boolean).join("").trim() || "git worktree add failed";

    removeIfEmptyDirectory(workspacePath);
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

export async function cleanupManagedWorktree({ repoRoot, workspacePath, branch }: ManagedWorktreeCleanup): Promise<void> {
  const remove = await runGit(["-C", repoRoot, "worktree", "remove", "--force", workspacePath]);
  if (remove.status !== 0) {
    throw new Error([remove.stderr, remove.stdout].filter(Boolean).join("").trim() || "Failed to remove worktree");
  }

  const prune = await runGit(["-C", repoRoot, "worktree", "prune"]);
  if (prune.status !== 0) {
    throw new Error([prune.stderr, prune.stdout].filter(Boolean).join("").trim() || "Failed to prune worktree metadata");
  }

  const deleteBranch = await runGit(["-C", repoRoot, "branch", "-D", branch]);
  if (deleteBranch.status !== 0) {
    throw new Error([deleteBranch.stderr, deleteBranch.stdout].filter(Boolean).join("").trim() || "Failed to delete branch");
  }
}
