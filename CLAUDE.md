# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start dev environment (main process + renderer, hot-reload)
bun run dev

# Production build
bun run build

# Preview production build
bun run start

# Type-check both src/ and electron/
bun run typecheck

# Rebuild native modules (e.g. after Electron version bump)
bun run rebuild
```

There are automated tests — run `bun run test`. TypeScript strict mode is enabled with `noUnusedLocals` and `noUnusedParameters` — unused variables are compile errors. Package manager is **bun** (see `bun.lock`). Use `bun` instead of `npm`/`yarn`.

---

## Architecture

This is an **Electron** desktop application with a React + TypeScript renderer and a Node.js main process.

### Two-process model

| Layer | Location | Language | Entry point |
|---|---|---|---|
| Renderer (UI) | `src/` | TypeScript / React 19 | `src/main.tsx` → `src/App.tsx` |
| Main process (backend) | `electron/` | TypeScript / Node.js | `electron/main.ts` |

### IPC — Frontend ↔ Backend

- **Renderer → Main:** `window.electronAPI.<method>(args)` — a typed bridge defined in `electron/preload.ts` via `contextBridge.exposeInMainWorld`. Use the `ipc` wrapper in `src/lib/ipc.ts` rather than calling `window.electronAPI` directly.
- **Main → Renderer (push events):** `webContents.send(channel, payload)` — subscribed to via `window.electronAPI.on(channel, listener)` / `onSessionEvent()` in `src/lib/ipc.ts`.
- **IPC channel constants** live in `electron/ipc-channels.ts` — always use those instead of raw strings.
- **Adding a new IPC handler:** add the channel constant to `ipc-channels.ts`, add `ipcMain.handle(CH.*, handler)` in `electron/main.ts`, expose the method in `electron/preload.ts`, and add the wrapper to `src/lib/ipc.ts`.

### Electron main process modules (`electron/`)

| Module | Role |
|---|---|
| `main.ts` | App entry, creates `BrowserWindow`, registers all `ipcMain` handlers |
| `preload.ts` | `contextBridge` — exposes typed `window.electronAPI` to the renderer |
| `ipc-channels.ts` | Shared IPC channel name constants |
| `config.ts` | Loads `~/.aichemist/.env` via `dotenv`; resolves API keys |
| `db.ts` | Opens `~/.aichemist/aichemist.db` via `better-sqlite3`; forward-only migrations |
| `projects.ts` | CRUD for projects + per-project JSON config |
| `sessions.ts` | CRUD for sessions and messages; includes `updateSessionAgent()` |
| `dialog.ts` | Native folder picker via Electron's `dialog` module |
| `settings.ts` | App-level settings persisted as JSON |
| `agent/runner.ts` | Dispatches agent turns to the appropriate provider |
| `agent/claude.ts` | Claude agent runner (Anthropic); discovers agents via SDK `supportedAgents()` |
| `agent/copilot.ts` | Copilot agent runner (GitHub); discovers agents by scanning `.md` files on disk |
| `agent/mcp-tools.ts` | MCP tool approval gate |

### Layout

`AppShell` uses a **vertical flex layout** (`flex-col`):
1. `TitleBar` — full-width macOS-style title bar (38px, draggable via `WebkitAppRegion: drag`, `data-drag-region="true"`). Left/right 70px spacers keep the centred app name clear of the native traffic-light buttons (`titleBarStyle: "hiddenInset"`).
2. A horizontal `flex-row` below containing `ProjectSidebar` + `main` area.

### Interactive terminal

`src/components/session/InteractiveTerminal.tsx` renders a real interactive shell using **xterm.js** (`@xterm/xterm` + `@xterm/addon-fit`) in the renderer and **node-pty** in the main process.

| IPC channel | Direction | Purpose |
|---|---|---|
| `TERMINAL_CREATE` | renderer → main | Spawn a PTY (respects `$SHELL`, cwd = project path). Returns a UUID. |
| `TERMINAL_INPUT` | renderer → main | Forward keystrokes to the PTY. |
| `TERMINAL_RESIZE` | renderer → main | Sync cols/rows after container resize. |
| `TERMINAL_CLOSE` | renderer → main | Kill the PTY. |
| `TERMINAL_OUTPUT` | main → renderer (push) | Stream PTY output to xterm. |

`node-pty` is a native module — it must be rebuilt after an Electron version bump. The `rebuild` script covers both it and `better-sqlite3`:
```bash
bun run rebuild   # electron-rebuild -f -w better-sqlite3 -w node-pty
```

**Testing xterm.js components:** jsdom has no canvas, so mock `@xterm/xterm` and `@xterm/addon-fit` using `vi.fn().mockImplementation(function() { ... })` (arrow functions are not constructors). Also stub `global.ResizeObserver` the same way.

### Frontend data flow

1. User message → `useAgentTurn.sendMessage()` (hook in `src/lib/hooks/`)
2. Persists user message via `ipc.saveMessage()` → SQLite
3. Calls `ipc.agentSend({ sessionId, prompt })` → main process runs the agent turn
4. Main process streams events back: `SESSION_STATUS`, `SESSION_DELTA`, `SESSION_TOOL_CALL`, `SESSION_TOOL_RESULT`, `SESSION_APPROVAL_REQUIRED`, `SESSION_MESSAGE`
5. `useSessionEvents` hook (mounted once in `AppShell`) subscribes via `onSessionEvent()` and updates the Zustand session store
6. Approval-gated tools: main emits `SESSION_APPROVAL_REQUIRED`; UI shows approval dialog; renderer calls `ipc.approveToolCall()`

**Session history hydration:** `listSessions()` returns metadata only (`messages: []`). When `activeSessionId` changes, `useSessionHydration` (mounted in `App.tsx`) calls `ipc.getSession()` to load the full message history and calls `hydrateSession()` on the store. `mergeSessions()` deliberately preserves existing messages to avoid a race where a metadata refresh wipes hydrated history.

### State management (Zustand)

- `useSessionStore` — sessions, messages, streaming text, live tool calls, pending approvals, terminal output, and `sessionAgents` (maps `sessionId → agentName | null`). Only `activeSessionId` is persisted (session data lives in SQLite). `sessionAgents` is restored from `session.agent` via `hydrateSession()` on navigation.
- `useProjectStore` — projects list, active project. Only `activeProjectId` is persisted.

### Database

SQLite at `~/.aichemist/aichemist.db`. Schema: `projects` → `sessions` → `messages` → `tool_calls` (cascade deletes). Config stored as JSON in `projects.config`. The `sessions` table has an `agent TEXT` column storing the selected agent name (nullable). Migrations in `electron/db.ts` are **append-only** — never modify existing SQL.

---

## Agent Selection

The app has a VS Code-style **agent picker** in the input bar (`src/components/session/AgentPickerButton.tsx`). It replaces the old Agents tab (which is now the **Skills** tab, showing only skills/tools from `.agents/skills/`).

### How it works

1. User clicks the agent picker button next to the message input.
2. The dropdown loads available agents (lazy, cached after first fetch) via `ipc.getClaudeAgents()` or `ipc.getCopilotAgents()` depending on the active provider.
3. Selecting an agent calls `ipc.updateSessionAgent(sessionId, agentName)` — persisted to `sessions.agent` in SQLite.
4. On the next `agentSend`, the runner picks up the agent and activates it:
   - **Claude:** `options.agent = agentName` passed to Claude Code SDK
   - **Copilot:** `session.rpc.agent.select({ name })` called before `send()`
5. Selected agent name is shown on the session tab as a `Bot` icon badge (visible on all tabs, not just the active one).

### Agent file format

Both Claude and Copilot agents use the same frontmatter format:

```markdown
---
name: my-agent
description: What this agent does
---
System prompt / instructions here.
```

### Agent discovery locations

| Provider | Locations scanned |
|---|---|
| Claude | `~/.claude/agents/*.md` + SDK `supportedAgents()` |
| Copilot | `.agents/copilot-agents/*.md` (project) and `~/.github-copilot/agents/*.md` (global) |

### Viewing and editing agents

Both `AgentsPanel` and `AgentPickerButton` show per-agent action icons on hover:

- **Eye icon** — opens `AgentEditorModal` with `readOnly=true`: renders the agent's markdown body via `Streamdown` (frontmatter stripped), no Save/Delete, "Close" instead of "Cancel". Available for all agents including SDK built-ins (which show name + description since they have no file path).
- **Pencil icon** — opens `AgentEditorModal` in edit mode. Only shown for agents where `agent.editable !== false && agent.path`.

---

## Skills Panel

`src/components/session/SkillsPanel.tsx` lists skills discovered from `.agents/skills/` (project) and `~/.claude/skills/` (global). Each card supports three interactions:

- **Click card body** — toggles the skill on/off for the active session (persisted via `ipc.updateSessionSkills`).
- **Eye icon** (hover) — opens `SkillEditorModal` with `readOnly=true` to view the skill's rendered markdown.
- **Pencil icon** (hover) — opens `SkillEditorModal` in edit mode to modify `SKILL.md`.

A **New Skill** button at the bottom opens `SkillEditorModal` with `skill=null` (create mode).

### SkillEditorModal / AgentEditorModal — readOnly prop

Both modals accept `readOnly?: boolean`. When `true`:
- The file is still loaded via `ipc.readFile` (or `ipc.readFile` with `skill.path/SKILL.md`)
- Content is rendered as markdown via `Streamdown` (frontmatter stripped with `stripFrontmatter()`)
- Save and Delete buttons are hidden; "Cancel" becomes "Close"
- Title changes from "Edit X — name" to "X — name"

---

## API Keys / Config

Place in `~/.aichemist/.env` — loaded at startup by `electron/config.ts` via `dotenv`.

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Primary Anthropic key |
| `ANTHROPIC_AUTH_TOKEN` | Fallback key (checked when `ANTHROPIC_API_KEY` is absent) |
| `ANTHROPIC_BASE_URL` | Custom base URL / proxy endpoint |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override any model ID containing `"sonnet"` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override any model ID containing `"haiku"` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override any model ID containing `"opus"` |
| `GITHUB_TOKEN` | GitHub Copilot key |
| `CLAUDE_CODE_PATH` | Explicit path to the `claude` CLI binary |

Model overrides match by substring (e.g. `claude-sonnet-4-6` → overridden by `ANTHROPIC_DEFAULT_SONNET_MODEL`).

---

## AI Elements

The AI Elements skill is installed at `.agents/skills/ai-elements/`. Reference docs for every component live at `.agents/skills/ai-elements/references/<component>.md`.

**Critical — no `useChat`:** AI Elements examples use `useChat` from `@ai-sdk/react`, which requires an HTTP endpoint and **does not work in Electron**. This project drives AI Elements components from Zustand state updated by push events from the main process. Do not use `useChat`.

**`@/` alias required** for all AI Elements imports (`@/components/ai-elements/...`). Configured in both `vite.config.ts` (`resolve.alias`) and `tsconfig.json` (`paths`).

### UI component gotchas

**`DropdownMenu` uses Base UI, not Radix UI.** `src/components/ui/dropdown-menu.tsx` wraps `@base-ui/react/menu`. Base UI's `Menu.Item` fires `onClick`, **not** `onSelect`. Always use `onClick` on `DropdownMenuItem` — `onSelect` silently does nothing.

**`DropdownMenuTrigger` does not support `asChild`** — style it directly with `className`.

**`ModelSelectorTrigger` does not support `asChild`** — style it directly with `className`.

---

## Key Conventions

### Path alias

`@/` resolves to `src/` — always use it for non-relative imports within `src/`.

### Types

`src/types/index.ts` defines shared types mirroring the SQLite schema. Field names use **snake_case**. Do not rename them to camelCase.

### Styling

Tailwind CSS v4 (via `@tailwindcss/vite` plugin). UI primitives are shadcn/ui components in `src/components/ui/`. Use `cn()` from `src/lib/utils.ts` for conditional class merging.

**⚠️ Tailwind v4 does not scan `node_modules`:** If a third-party component (e.g. `streamdown`) renders Tailwind arbitrary-value classes from its dist bundle, those classes will never be generated. Add explicit CSS rules in `src/index.css` instead of relying on those classes being present. Example: streamdown's syntax-highlighted token spans write color values as inline CSS custom properties (`--sdm-c`, `--shiki-dark`); `index.css` has `[data-streamdown="code-block"] span { color: var(--sdm-c, inherit); }` to apply them.

---

## Known SDK Footguns

### Claude Code SDK — `allowedTools` vs `tools`

These two `Options` fields look similar but do completely different things:

| Field | Effect |
|---|---|
| `allowedTools: string[]` | **Auto-approves** the listed tools without an interactive permission prompt. Does **not** restrict availability. |
| `tools: string[]` | **Restricts** available built-in tools to exactly that list — and also blocks MCP tools from our custom server. |

**Never change `allowedTools` to `tools`** in `electron/agent/claude.ts`. Doing so silently prevents all MCP tool calls (write_file, execute_bash, web_fetch, delete_file), leaving the agent unable to do anything useful without showing any error to the user.

The correct pattern:
- Use `allowedTools` to suppress permission prompts for safe native tools (Read, Glob, LS, …).
- Leave `tools` unset so our MCP server tools remain accessible.
- Track file changes from native `Write`/`Edit` tool calls via the `pendingFileChanges` intercept in `claude.ts`, not by restricting native tools.
