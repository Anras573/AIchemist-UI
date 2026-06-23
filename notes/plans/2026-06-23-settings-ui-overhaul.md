# Settings UI Overhaul — Implementation Plan

_2026-06-23_

## Goal

Replace today's settings surfaces with a single, searchable **Settings hub** that
is provider-centric, task-shaped, and autosaving. Fold MCP servers, Skills, and
Agents *configuration* into the hub while keeping their per-session *activation*
in the existing right-hand context panels.

Decisions (locked):

- **Save model:** autosave everywhere (on blur for text, on-change for toggles),
  with a transient "Saved ✓" + short undo window. No manual Save buttons.
- **Scope:** MCP / Skills / Agents move into the hub as management sections;
  context panels become thin consumers / quick-toggles.
- **Ambition:** full IA redesign (not an incremental re-skin).

Backends are unchanged — this is a presentation-layer redesign over existing IPC
handlers. No DB migration, no `.env` / `mcp.json` / `openai-providers.json` format
changes.

## Guiding principle

> **Configuration is global and lives in the hub. Activation is per-session and
> lives in the panels.** The hub owns "what exists"; panels own "what's on for
> this session."

This is what makes "bring all three in" tractable without duplicating the
session-locked toggle logic.

---

## Target IA

Single full-screen view, two-tier searchable nav:

```
┌ Search settings…                                              ┐
│ APPLICATION                                                   │
│   Providers & Keys     (Anthropic / Copilot / Ollama / OAI)   │
│   MCP Servers          (~/.aichemist/mcp.json CRUD + probes)  │
│   Skills               (global / plugin skill management)     │
│   Agents               (global agent files)                   │
│   Appearance           (theme)                                │
│   Advanced             (default provider/approval, tool cap)  │
│                                                               │
│ PROJECT  [ active-project ▾ ]                                 │
│   General              (provider / model / worktree)          │
│   Approval & Safety                                           │
└───────────────────────────────────────────────────────────────┘
```

---

## Existing code inventory (what we touch)

| File | LOC | Fate |
|---|---|---|
| `src/components/settings/SettingsView.tsx` | 744 | **Rewrite** — becomes the hub shell + section router |
| `src/components/settings/ProjectSettingsContent.tsx` | 399 | **Refactor** — drop save-row, autosave; reused by hub |
| `src/components/settings/ProjectSettingsSheet.tsx` | 54 | **Delete** — single entry point now |
| `src/components/session/McpConfigEditorDialog.tsx` | 482 | **Extract** core into a hub section; keep a thin dialog or retire |
| `src/components/session/McpServersPanel.tsx` | 323 | **Trim** — quick-toggle + "Manage in Settings" deep link |
| `src/components/session/SkillsPanel.tsx` | 372 | **Trim** — keep per-session toggle; "New/Edit" deep-links to hub |
| `src/components/session/SkillEditorModal.tsx` | 285 | **Reuse** as inline editor in Skills section |
| `src/components/session/AgentsPanel.tsx` | 222 | **Trim** similarly |
| `src/components/session/AgentEditorModal.tsx` | 294 | **Reuse** as inline editor in Agents section |
| `src/components/layout/AppShell.tsx` | — | Remove `ProjectSettingsSheet` mount |
| `src/lib/store/useProjectStore.ts` | 66 | Drop `projectSettingsOpen`; add hub nav state (below) |

### IPC already available (no backend work)

- Settings: `ipc.settingsRead()`, `ipc.settingsWrite(updates)`
- Probes: `ipc.probeProviders({ projectId?, force? })` + `useProviderProbes()`
- OpenAI endpoints: `readOpenAiEndpoints` / `upsertOpenAiEndpoint` / `deleteOpenAiEndpoint`
- MCP: `listMcpServers`, `mcpProbeManaged`, `mcpReadConfig`, `mcpWriteConfig`, `mcpDeleteServer`
- Skills: `listSkills(projectPath, provider)`, `updateSessionSkills`, `updateSessionDisabledMcp`
- Agents: `getClaudeAgents` / `getCopilotAgents`, `updateSessionAgent`
- Project config: `getProjectConfig` / `saveProjectConfig`

---

## New shared building blocks

Create `src/components/settings/primitives/` to host the redesign vocabulary so
sections stay declarative:

1. **`useAutosave(save, { debounceMs })`** (`src/lib/hooks/useAutosave.ts`)
   - Wraps a persist fn; exposes `{ status, commit, undo }` where `status` is
     `idle | saving | saved | error`. Debounces text fields, fires immediately for
     toggles. Holds the previous value for a ~5s undo window.
   - Single source of the "Saved ✓ / Undo / Save failed" affordance; replaces the
     per-section `saveStatus` maps in both current components.
2. **`<SettingField>`** — label + helper + inline status/undo + error slot. Variants
   for text, secret (show/hide, lifted from `SecretField`), select, number, toggle.
3. **`<SettingsSection>`** — title + description + children; consistent padding/width.
4. **`<ProbeBadge provider | endpoint>`** — reads `useProviderProbes` (or MCP probe)
   and renders ✓ Connected / Invalid key / Check base URL / Not running, with the
   reason as a tooltip. Re-fetches `force` after a connection-affecting autosave.
5. **`<SettingsSearch>`** — filters the nav rows + (optionally) field rows by a
   keyword index built from section/field labels.

---

## Build order (PR-sized steps)

Each step compiles, passes `bun run typecheck`, and is independently reviewable.

### Step 1 — Hub shell + nav state (no behavior change yet)
- Add hub nav state to `useProjectStore`: replace `projectSettingsOpen` with a
  `settingsSection` field (`{ scope: "app" | "project"; id: string }`) so deep
  links can target a section. Keep `settingsOpen`.
- Rewrite `SettingsView` as: searchable two-tier nav + a section router that, for
  now, renders the *existing* section bodies verbatim (cut/paste, no redesign).
- Delete `ProjectSettingsSheet`; remove its mount + `projectSettingsOpen` usage in
  `AppShell`. Repoint every `openProjectSettings()` caller to
  `openSettings()` + `settingsSection = { scope: "project", id: "general" }`.
- Update `SettingsView.test.tsx` / `ProjectSettingsSheet.test.tsx` / `AppShell.test.tsx`.

### Step 2 — Autosave primitives + adopt in Appearance/Advanced
- Add `useAutosave`, `<SettingField>`, `<SettingsSection>`.
- Convert the simplest sections first (Appearance is already autosave; Advanced =
  today's Defaults) to validate the pattern end-to-end. Remove their Save buttons.

### Step 3 — Providers & Keys section (the centerpiece)
- One card per provider folding today's `API Keys` + `Model Overrides` + `Providers`:
  - Anthropic: key, auth-token fallback, base URL, tier overrides (collapsible
    "Advanced"), enabled toggle, `<ProbeBadge provider="anthropic">`.
  - Copilot: `GITHUB_TOKEN`, enabled toggle, probe badge.
  - Ollama: reachability badge + installed-model count, enabled toggle.
  - OpenAI-compatible: inline endpoints manager (port `OpenAiEndpointsSection`),
    per-endpoint probe badge.
- Enabled toggle writes `AICHEMIST_DISABLED_PROVIDERS` (reuse
  `parse/serializeDisabledProviders`). Keep the "all disabled" guard.
- Autosave on blur for keys/URLs → trigger `probeProviders({ force: true })`.
- Retire the old `API Keys` / `Model Overrides` / `Providers` section bodies.

### Step 4 — Project General + Approval into the hub
- Refactor `ProjectSettingsContent` to drop its `SaveRow` and use `useAutosave`
  per field (calls `saveProjectConfig`). Keep `ProjectConfig` shape + normalize
  rules (anthropic default model) intact.
- Add **inheritance ghost text**: General shows the app default
  (`AICHEMIST_DEFAULT_PROVIDER`, etc.) as placeholder when the project inherits.
- Project switcher (`[ active-project ▾ ]`) in the PROJECT nav group instead of the
  flat project list (multiple projects still reachable).

### Step 5 — MCP Servers section
- Promote `McpConfigEditorDialog`'s editor into a hub section: list + add/edit/delete
  via `mcpReadConfig/Write/Delete`, with live `mcpProbeManaged` health per row
  (connected / tools / error) + a force-refresh.
- `McpServersPanel` keeps its per-session **disable toggle**
  (`updateSessionDisabledMcp`) and gets a "Manage servers →" deep link
  (`openSettings()` + `settingsSection = { scope: "app", id: "mcp" }`).
- Decide on `McpConfigEditorDialog`: either retire it or keep as a thin wrapper that
  routes to the hub. Prefer retire to avoid two editors.

### Step 6 — Skills + Agents sections
- Skills section: list global/plugin skills (`listSkills`), edit via the existing
  `SkillEditorModal` rendered inline (it already supports view/edit/create + readOnly).
- Agents section: list `getClaudeAgents` / `getCopilotAgents`, edit via
  `AgentEditorModal` (already supports readOnly + editable gating).
- Panels (`SkillsPanel`, `AgentsPanel`/`AgentPickerButton`) keep per-session
  toggle/select; their "New/Edit" affordances deep-link into the hub sections.
- Provider context: the hub's Skills/Agents listing is provider-aware. Use the
  active session's provider via `useActiveSessionProvider()`, falling back to the
  app default provider when no session is active (hub can be opened with no session).

### Step 7 — Search + polish
- Wire `<SettingsSearch>` over the nav + field label index.
- Empty/loading/error states, keyboard nav (Esc closes, already present), focus mgmt.
- Remove dead code (old `SecretField`/`SaveRow`/`saveSection`, `projectSettingsOpen`).

---

## Testing

- **Unit (vitest + RTL):** `useAutosave` (debounce, undo, error), `<ProbeBadge>`
  states, Providers section toggle → `AICHEMIST_DISABLED_PROVIDERS` round-trip,
  project inheritance ghost text, deep-link nav from panels.
- **Migrate** existing `SettingsView.test.tsx` / `ProjectSettingsSheet.test.tsx` /
  `ProjectSettingsContent` tests to the new structure (the sheet test folds into
  the hub project-section test).
- Mock IPC via existing `src/test/setup.ts` patterns.
- `bun run typecheck` clean (strict, `noUnusedLocals`) after every step.

## Risks / watch-outs

- **Provider context with no active session.** Skills/Agents/MCP are provider-aware
  but the hub can be opened standalone — fall back to app default provider; never
  assume a session.
- **Autosave + probes feedback loop.** Debounce key edits and only force-probe on
  commit, not per keystroke (probe cache is 30s; honor it).
- **Two MCP editors.** Don't ship both `McpConfigEditorDialog` and the hub section
  long-term — retire the dialog in Step 5.
- **Don't move activation into the hub.** Per-session skill/MCP toggles and agent
  selection must stay session-scoped (they write session rows, not global config).
- **Secret handling unchanged.** Keys still land in `~/.aichemist/.env`; keep the
  show/hide masking. No new exposure surface.
</content>
</invoke>
