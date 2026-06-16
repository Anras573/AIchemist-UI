import { useIpc } from "@/lib/ipc";
import { useIpcQuery } from "@/lib/hooks/useIpcQuery";

export interface UseGitBranchResult {
  /** The current branch, or `null` while loading, on error, or with no path. */
  branch: string | null;
  /** `true` while the initial branch lookup is in flight. */
  loading: boolean;
}

/**
 * Resolves the current git branch for a workspace path, cached and de-duplicated
 * via {@link useIpcQuery}. Both `InputBar` (branch badge) and `OpenPrSection`
 * (default head branch) read the same branch for the same path; sharing one
 * cache key collapses their previously-independent `getGitBranch()` round-trips
 * into a single IPC call (issue #57).
 */
export function useGitBranch(path: string | null | undefined): UseGitBranchResult {
  const ipc = useIpc();
  const key = path ? `git-branch:${path}` : null;
  const { data, loading } = useIpcQuery<string | null>(
    key,
    () => ipc.getGitBranch(path as string).catch(() => null),
  );
  return { branch: data ?? null, loading };
}
