# Worktree-backed sessions

Date: 2026-05-28

## Problem

Sessions currently share the project checkout. That means file edits, terminal commands, and git-aware tooling all operate in the same working tree, which defeats the goal of isolating session work.

## Goals

- Create a separate git worktree per session when the project setting is enabled.
- Keep the existing project root as the canonical repo identity.
- Let users override the base directory used for managed worktrees.
- Preserve the current non-blocking behavior if worktree creation fails.
- Offer cleanup for both the worktree and its branch when a session is deleted.

## Non-goals

- Supporting non-git projects with worktrees.
- Auto-merging or rebasing session branches.
- Sharing one worktree across multiple sessions.

## Design

### Project settings

Add a project-level toggle for session worktrees and a configurable base path for managed worktrees.

- `create_worktree_per_session: boolean`
- `worktree_root_path?: string`

Default behavior:

- enabled only when the project is a git repository
- managed worktrees are created under the project’s parent directory

If `worktree_root_path` is set, use that instead of the parent directory.

### Session data

Extend sessions with:

- `branch TEXT`
- `workspace_path TEXT`

`workspace_path` is the cwd for the session runtime and all filesystem/git operations. For a successful worktree-backed session, it points at the new worktree path. If worktree creation fails, it falls back to `project.path`.

### Creation flow

When creating a session:

1. Resolve the repo root from `project.path`.
2. If worktrees are disabled or the repo is not git-backed, create a normal session in `project.path`.
3. Otherwise, choose the managed root:
   - `worktree_root_path` if configured
   - else the project’s parent directory
4. Derive a unique branch and folder name from the session id.
5. Run `git worktree add -b <branch> <worktree_path> <repo_root>`.
6. Persist the session with `branch` and `workspace_path`.

If worktree creation fails for any reason, log a warning and still create the session in the main checkout rather than blocking the user.

### Runtime routing

All session-scoped paths should use `workspace_path` instead of `project.path`:

- terminal cwd
- file reads/writes
- git diff / status helpers
- agent runner cwd
- any path shown in session-specific UI

`project.path` remains the repo root for project-level operations and settings.

### Deletion flow

If `workspace_path === project.path`, delete the session normally.

If the session owns a worktree, show a confirmation dialog that offers to remove both the worktree and its branch. The default should be destructive cleanup, but the user must confirm it.

Cleanup order:

1. Remove the worktree.
2. Prune stale git metadata.
3. Delete the session branch if it was created by the app.

If cleanup fails, surface the error and leave the session deletion decision explicit rather than silently swallowing it.

## UI changes

- Project settings: add the worktree toggle and root-path override.
- Session tabs / header: show the session branch when present, reusing the existing branch badge slot.
- Session delete dialog: include the worktree cleanup choice.

## Error handling

- Branch name collisions should retry with a more specific suffix before falling back.
- Invalid override paths should surface a validation error and fall back to the default managed root.
- Worktree creation failure should degrade to the current checkout, not prevent session creation.

## Testing

- Worktree root resolution with default and overridden paths.
- Session creation success path and fallback path.
- Session deletion cleanup only when a managed worktree exists.
- Badge rendering for sessions with and without `branch` / `workspace_path`.

