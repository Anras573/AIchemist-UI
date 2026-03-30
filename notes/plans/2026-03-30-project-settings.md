# Project Settings UI

Date: 2026-03-30

## Problem

`ProjectConfig` (provider, model, approval rules) is stored per-project in `.aichemist/config.json`
and fully plumbed through IPC, but there is no UI to view or edit it. Users must edit the JSON
file manually.

## Approach

A sheet/drawer (`ProjectSettingsSheet.tsx`) slides in from the right when the user clicks a gear
icon on the active project row in the sidebar. Two tabs — **General** and **Approval** — cover
provider, model, and approval rules. `custom_tools` is out of scope for this iteration.

No new IPC channels are needed; `ipc.getProjectConfig` / `ipc.saveProjectConfig` already exist.

## Design

### Trigger

- Gear icon appears on hover on the **active** project row in `ProjectSidebar.tsx`
- Calls `openProjectSettings()` from `useProjectStore`

### State

Add to `useProjectStore`:

```ts
projectSettingsOpen: boolean
openProjectSettings: () => void
closeProjectSettings: () => void
```

### Sheet structure

```
┌──────────────────────────────────────┐
│  Project Settings          [✕ close] │
│  ────────────────────────────────────│
│  [General] [Approval]                │  ← tabs
│  ────────────────────────────────────│
│  (tab content)                       │
│                                      │
│  ────────────────────────────────────│
│  [Save]  (saved ✓ / error message)   │
└──────────────────────────────────────┘
```

**General tab**
- Provider: `<Select>` with options `anthropic` / `copilot`
- Model: `<Input>` text field (e.g. `claude-sonnet-4-5`)

**Approval tab**
- Approval mode: `<Select>` with options `all` / `none` / `custom`
- When `custom`: one row per category (`filesystem`, `shell`, `web`), each with a
  `<Select>` for policy (`always` / `never` / `risky_only`)
- When `all` or `none`: per-rule rows hidden

### Data flow

1. Sheet mounts → `ipc.getProjectConfig(activeProjectId)` → local state
2. User edits fields → local state only (no auto-save)
3. User clicks **Save** → `ipc.saveProjectConfig(id, config)` → update `projects` in store
4. "Saved ✓" badge appears for 2.5 s, then resets (same pattern as `SettingsView`)
5. Sheet closes on ✕ button or Escape key

### Error handling

| Scenario | Behaviour |
|---|---|
| Load fails | Error message inside sheet instead of form; retry button |
| Save fails | Inline error banner below Save; sheet stays open |

## Files changed

| File | Change |
|---|---|
| `src/lib/store/useProjectStore.ts` | Add `projectSettingsOpen`, `openProjectSettings`, `closeProjectSettings` |
| `src/components/layout/ProjectSidebar.tsx` | Add gear icon button on active project row |
| `src/components/layout/AppShell.tsx` | Render `<ProjectSettingsSheet>` when `projectSettingsOpen` |
| `src/components/settings/ProjectSettingsSheet.tsx` | New — sheet with General + Approval tabs |

## Testing

- Sheet renders General tab with correct provider and model loaded from config
- Approval tab shows per-rule rows only when `approval_mode === "custom"`
- Switching mode to `"all"` hides the rule rows
- Save calls `ipc.saveProjectConfig` with the updated config object
- Save error displays inline error message

## Out of scope

- `custom_tools` editing
- MCP server configuration
- Per-session config overrides
