import { useEffect, useState } from "react";
import type { Session } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SessionDeleteDialogProps {
  open: boolean;
  session: Session | null;
  projectPath: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (cleanupWorktree: boolean) => Promise<void>;
}

export function SessionDeleteDialog({
  open,
  session,
  projectPath,
  onOpenChange,
  onConfirm,
}: SessionDeleteDialogProps) {
  const managedWorktree = Boolean(
    session?.branch &&
      session.workspace_path &&
      session.workspace_path !== projectPath
  );
  const [cleanupWorktree, setCleanupWorktree] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCleanupWorktree(managedWorktree);
    setError(null);
    setSubmitting(false);
  }, [managedWorktree, session?.id, open]);

  if (!session) return null;

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(cleanupWorktree);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete session?</DialogTitle>
          <DialogDescription>
            {managedWorktree
              ? "This session has its own worktree and branch. You can remove them from disk too."
              : "This will delete the session and its messages."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="font-medium">{session.title}</div>
            {session.branch && (
              <div className="mt-1 text-xs text-muted-foreground">
                Branch: {session.branch}
              </div>
            )}
            {session.workspace_path && managedWorktree && (
              <div className="mt-1 text-xs text-muted-foreground break-all">
                Workspace: {session.workspace_path}
              </div>
            )}
          </div>

          {managedWorktree && (
            <label className="flex items-start gap-2 rounded-md border px-3 py-2">
              <input
                type="checkbox"
                checked={cleanupWorktree}
                onChange={(e) => setCleanupWorktree(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                Remove the worktree and branch too
              </span>
            </label>
          )}

          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter showCloseButton={false}>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={submitting}>
            {submitting ? "Deleting…" : "Delete session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
