# AIchemist-UI — Copilot Instructions

## Project Overview

AIchemist-UI is an **Electron desktop AI assistant** — a React/TypeScript renderer process over a Node.js main process. The app lets users point it at a project directory and chat with an LLM agent that can read/write files, run shell commands, and fetch URLs.

---

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

There are no automated tests currently. TypeScript strict mode is enabled with `noUnusedLocals` and `noUnusedParameters` — unused variables are compile errors.

---

## Architecture

### Two-process model

| Layer | Location | Language | Entry point |
|---|---|---|---|
| Renderer (UI) | `src/` | TypeScript / React 19 | `src/main.tsx` → `src/App.tsx` |
| Main process (backend) | `electron/` | TypeScript / Node.js | `electron/main.ts` |

### IPC — Frontend ↔ Backend

- **Renderer → Main:** `window.electronAPI.<method>(args)` — typed bridge defined in `electron/preload.ts` via `contextBridge`. Use the `ipc` wrapper in `src/lib/ipc.ts` rather than calling `window.electronAPI` directly.
- **Main → Renderer (push events):** `webContents.send(channel, payload)` — subscribed to via `onSessionEvent()` from `src/lib/ipc.ts`.
- **Channel constants** live in `electron/ipc-channels.ts` — always use those instead of raw strings.
- **Adding a new IPC method:** add the channel constant to `ipc-channels.ts`, add `ipcMain.handle(CH.*, handler)` in `electron/main.ts`, expose it in `electron/preload.ts`, add the wrapper to `src/lib/ipc.ts`.

### Electron main process modules (`electron/`)

| Module | Role |
|---|---|
| `main.ts` | App entry, creates `BrowserWindow`, registers all `ipcMain` handlers |
| `preload.ts` | `contextBridge` — exposes typed `window.electronAPI` to the renderer |
| `ipc-channels.ts` | Shared IPC channel name constants |
| `config.ts` | Loads `~/.aichemist/.env` via `dotenv`; resolves API keys |
| `db.ts` | Opens `~/.aichemist/aichemist.db` via `better-sqlite3`; forward-only migrations |
| `projects.ts` | CRUD for projects + per-project JSON config |
| `sessions.ts` | CRUD for sessions and messages |
| `dialog.ts` | Native folder picker via Electron's `dialog` module |
| `settings.ts` | App-level settings persisted as JSON |
| `agent/runner.ts` | Dispatches agent turns to the appropriate provider |
| `agent/claude.ts` | Claude agent runner (Anthropic) |
| `agent/copilot.ts` | Copilot agent runner (GitHub) |
| `agent/mcp-tools.ts` | MCP tool approval gate |

### Frontend data flow

1. User message → `useAgentTurn.sendMessage()` (hook in `src/lib/hooks/`)
2. Persists user message via `ipc.saveMessage()` → SQLite
3. Calls `ipc.agentSend({ sessionId, prompt })` → main process runs the agent turn
4. Main process streams events back: `SESSION_STATUS`, `SESSION_DELTA`, `SESSION_TOOL_CALL`, `SESSION_TOOL_RESULT`, `SESSION_APPROVAL_REQUIRED`, `SESSION_MESSAGE`
5. `useSessionEvents` hook (mounted once in `AppShell`) subscribes via `onSessionEvent()` and updates Zustand
6. Approval-gated tools: main emits `SESSION_APPROVAL_REQUIRED`; UI shows approval dialog; renderer calls `ipc.approveToolCall()`

**Session history hydration:** `listSessions()` returns metadata only (`messages: []`). When `activeSessionId` changes, `useSessionHydration` (mounted in `App.tsx`) calls `ipc.getSession()` to load full message history and calls `hydrateSession()` on the store. `mergeSessions()` deliberately preserves existing messages to avoid a race where a metadata refresh wipes hydrated history.

### State management (Zustand)

- `useSessionStore` — sessions, messages, streaming text, live tool calls, pending approvals, terminal output. Only `activeSessionId` is persisted (session data lives in SQLite).
- `useProjectStore` — projects list, active project. Only `activeProjectId` is persisted.

### Database

SQLite at `~/.aichemist/aichemist.db`. Schema: `projects` → `sessions` → `messages` → `tool_calls` (cascade deletes). Config stored as JSON in `projects.config`. Migrations in `electron/db.ts` are **append-only** — never modify existing SQL.

### API keys / config

Place in `~/.aichemist/.env` — loaded at startup by `electron/config.ts` via `dotenv`.

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | Anthropic key (first wins) |
| `ANTHROPIC_BASE_URL` | Custom proxy endpoint |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override any model ID containing `"sonnet"` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override any model ID containing `"haiku"` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override any model ID containing `"opus"` |
| `GITHUB_TOKEN` | GitHub Copilot key |
| `CLAUDE_CODE_PATH` | Explicit path to the `claude` CLI binary |

---

## Agent Selection & Skills Panel

### Agent picker (`AgentPickerButton`)

VS Code-style dropdown in the input bar. Loads agents lazily via `ipc.getClaudeAgents()` / `ipc.getCopilotAgents()`. Each item has two hover icons:
- **Eye** — opens `AgentEditorModal` with `readOnly=true` (viewer)
- **Pencil** — opens `AgentEditorModal` in edit mode (only for `agent.editable !== false && agent.path`)

### Skills panel (`SkillsPanel`)

Lists skills from `.agents/skills/` and `~/.claude/skills/` (or `~/.agents/skills/` for Copilot) plus installed plugins. Each card:
- **Click** — toggles the skill on/off for the session
- **Eye icon** (hover) — opens `SkillEditorModal` with `readOnly=true`
- **Pencil icon** (hover) — opens `SkillEditorModal` in edit mode (user skills only; plugin skills are read-only)

Above the list:
- **Search input** — case-insensitive substring match against `name`, `description`, and `plugin`
- **Source filter chips** (`project` / `global` / `plugin`) — toggleable, with per-source counts. All on by default. Composes (AND) with search.

The (i) info tooltip describing discovery paths is rendered in the right-panel header beam by `ContextPanel.tsx` via the exported `SkillsHeaderInfo` component, not inside the panel body.

### readOnly viewer pattern

Both `SkillEditorModal` and `AgentEditorModal` accept `readOnly?: boolean`. When `true`:
- Frontmatter stripped via `stripFrontmatter()`, body rendered with `Streamdown`
- Title: "X — name" (not "Edit X — name")
- "Cancel" → "Close"; Save and Delete hidden
- For SDK built-in agents (no `path`): renders name + description; skips `ipc.readFile`

---

## Key Conventions

### AI Elements components

The AI Elements skill is installed at `.agents/skills/ai-elements/`. Reference docs for every component live at `.agents/skills/ai-elements/references/<component>.md`.

- Use `@/components/ai-elements/...` (the `@/` alias is required)
- **Do not use `useChat`** from `@ai-sdk/react` — it requires an HTTP endpoint and does not work in Electron. All AI state is driven from Zustand updated by push events from the main process.
- **`ModelSelectorTrigger` does not support `asChild`** — style it directly with `className`

### Path alias

`@/` resolves to `src/` — configured in both `electron.vite.config.ts` (`resolve.alias`) and `tsconfig.json` (`paths`). Always use `@/` for non-relative imports within `src/`.

### Types

`src/types/index.ts` defines shared types mirroring the SQLite schema. Field names use **snake_case**. Do not rename them to camelCase.

### Package manager

Use **`bun`** (not npm/yarn). Lock file is `bun.lock`.

### Styling

Tailwind CSS v4 (via `@tailwindcss/vite` plugin). UI primitives are shadcn/ui components in `src/components/ui/`. Use `cn()` from `src/lib/utils.ts` for conditional class merging.

**⚠️ Tailwind v4 does not scan `node_modules`:** If a third-party component (e.g. `streamdown`) renders Tailwind arbitrary-value classes from its dist bundle, those classes will never be generated. Add explicit CSS rules in `src/index.css` instead. Example: streamdown token spans write colors as inline CSS custom properties (`--sdm-c`, `--shiki-dark`); `index.css` targets `[data-streamdown="code-block"] span` to apply them.
