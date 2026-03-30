# Changes Panel — Session File Writes + Git Diff

Date: 2026-03-30

## Goal

Add a **Changes** tab to the right-side panel showing:
1. **Session writes** (Option B) — files written or deleted by the agent this session, as unified diffs. Always available, captured at write time.
2. **Git diff** (Option C) — full working tree diff (`git diff`). Available when the project is a git repo, refreshable on demand.

The panel auto-opens the first time the agent writes a file (same pattern as the Terminal tab auto-opening on `execute_bash`).

---

## Design Decisions

- **Unified diff format** — standard `+/-` line style; same renderer for both sections.
- **Both sections shown** — session writes on top, git diff below (when available).
- **Diff computed in main process** — only the diff string is sent over IPC; large file contents are never transferred to the renderer.
- **`diff` npm package** — used in the main process to compute unified diffs from before/after content. ~20KB, pure JS, MIT licence, 52M weekly downloads.

---

## Types

Add to `src/types/index.ts`:

```ts
export interface FileChange {
  path: string;          // absolute path
  relativePath: string;  // relative to project root, for display
  diff: string;          // pre-computed unified diff string
  operation: "write" | "delete";
}

export interface SessionFileChangeEvent {
  session_id: string;
  file_change: FileChange;
}
```

---

## New Files

| File | Purpose |
|---|---|
| `src/components/session/ChangesPanel.tsx` | Panel UI — two sections (session writes, git diff) |

---

## Modified Files

| File | Change |
|---|---|
| `src/types/index.ts` | Add `FileChange` + `SessionFileChangeEvent` |
| `electron/ipc-channels.ts` | Add `SESSION_FILE_CHANGE` push channel + `GET_GIT_DIFF` request channel |
| `electron/agent/mcp-tools.ts` | Wrap `write_file`/`delete_file` handlers: read before → call impl → compute diff → `webContents.send(SESSION_FILE_CHANGE, ...)` |
| `electron/agent/copilot.ts` | Same wrap for Copilot provider |
| `electron/main.ts` | Add `GET_GIT_DIFF` handler: `execSync('git diff', { cwd: projectPath })` |
| `electron/preload.ts` | Expose `SESSION_FILE_CHANGE` listener + `getGitDiff` invoke |
| `src/lib/ipc.ts` | Add `getGitDiff(projectPath): Promise<string>` |
| `src/lib/store/useSessionStore.ts` | Add `sessionFileChanges: Record<string, FileChange[]>` + `addFileChange` action |
| `src/lib/hooks/useSessionEvents.ts` | Handle `SESSION_FILE_CHANGE` → `addFileChange` + `onAutoSwitch("changes")` |
| `src/components/session/ContextPanel.tsx` | Add `"changes"` to `ContextTab` type; add case in render; add header label |
| `src/components/session/ToolStrip.tsx` | Add `{ id: "changes", icon: GitCommitHorizontal, label: "Changes" }` |

---

## Data Flow

### Session writes (Option B)

```
Agent calls write_file { path, content }
  │
  ├─ mcp-tools.ts / copilot.ts tool handler:
  │    1. fs.readFileSync(path) → before  (null if new file or read error)
  │    2. implWriteFile(args)             → writes to disk
  │    3. createPatch(relativePath, before ?? '', content) → diffString
  │    4. webContents.send(SESSION_FILE_CHANGE, { session_id, file_change })
  │
renderer: useSessionEvents
  ├─ addFileChange(sessionId, fileChange) → sessionFileChanges in store
  └─ onAutoSwitch("changes")             → panel opens automatically
```

For `delete_file`: capture full before content, `after = ''`, all lines shown as removed.

### Git diff (Option C)

```
User clicks "Refresh" (or ChangesPanel mounts)
  │
  ipc.getGitDiff(projectPath)
  │
  main: execSync('git diff', { cwd: projectPath })
  │     → raw unified diff string
  │       (or error string if not a git repo / git not installed)
  │
ChangesPanel renders with shared DiffView component
```

---

## ChangesPanel UI

```
┌─────────────────────────────────┐
│ This Session          [2 files] │  ← collapsible section header
├─────────────────────────────────┤
│ src/components/Foo.tsx  [write] │  ← file header, collapsible
│  @@ -1,4 +1,6 @@               │
│  - old line                     │  ← red
│  + new line                     │  ← green
│    context line                 │
├─────────────────────────────────┤
│ Git Diff              [Refresh] │  ← section header with refresh button
├─────────────────────────────────┤
│  (rendered git diff output)     │
│  — or —                         │
│  "Not a git repository"         │
└─────────────────────────────────┘
```

### DiffView component

Shared between both sections. Splits the diff string by line and applies colours:

| Line prefix | Colour |
|---|---|
| `+` | `text-green-600 dark:text-green-400 bg-green-500/10` |
| `-` | `text-red-600 dark:text-red-400 bg-red-500/10` |
| `@@` | `text-blue-500 bg-blue-500/5 text-xs` |
| (other) | default muted |

Renders in a `<pre>` with horizontal scroll and monospace font.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| File doesn't exist before write | `before = null` → diff shows all lines as `+` (new file) |
| File is binary or read fails | Skip capture; diff shows `(binary file)` label |
| File deleted | `after = ''` → diff shows all lines as `-` |
| `git diff` fails (not a repo) | Git section shows info state: "Not a git repository" |
| `git diff` fails (git not installed) | Same info state, no crash |
| Session changes while panel open | Panel shows changes for `activeSessionId` only |

---

## Testing

- **`ChangesPanel`**: DiffView line colouring (`+` / `-` / `@@` / context), empty state ("No file changes this session"), loading state for git section.
- **`mcp-tools.ts` / `copilot.ts`**: `SESSION_FILE_CHANGE` emitted with correct `operation`, `relativePath`; `before = null` for new files; nothing emitted on write error.
- **`useSessionStore`**: `addFileChange` accumulates changes per session without cross-contaminating other sessions.
- No unit test for the `GET_GIT_DIFF` handler (external process — integration concern).

---

## Implementation Order

1. `diff` dependency + types
2. IPC channels + `GET_GIT_DIFF` handler + preload + `ipc.ts`
3. Agent runner wrapping (mcp-tools + copilot)
4. Store slice + `useSessionEvents` handler
5. `ChangesPanel` + `DiffView` component
6. Tab system wiring (ContextPanel + ToolStrip)
7. Tests
