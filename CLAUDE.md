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

There are no automated tests currently. TypeScript strict mode is enabled with `noUnusedLocals` and `noUnusedParameters` — unused variables are compile errors. Package manager is **bun** (see `bun.lock`). Use `bun` instead of `npm`/`yarn`.

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
5. `useSessionEvents` hook (mounted once in `AppShell`) subscribes via `onSessionEvent()` and updates the Zustand session store
6. Approval-gated tools: main emits `SESSION_APPROVAL_REQUIRED`; UI shows approval dialog; renderer calls `ipc.approveToolCall()`

**Session history hydration:** `listSessions()` returns metadata only (`messages: []`). When `activeSessionId` changes, `useSessionHydration` (mounted in `App.tsx`) calls `ipc.getSession()` to load the full message history and calls `hydrateSession()` on the store. `mergeSessions()` deliberately preserves existing messages to avoid a race where a metadata refresh wipes hydrated history.

### State management (Zustand)

- `useSessionStore` — sessions, messages, streaming text, live tool calls, pending approvals, terminal output. Only `activeSessionId` is persisted (session data lives in SQLite).
- `useProjectStore` — projects list, active project. Only `activeProjectId` is persisted.

### Database

SQLite at `~/.aichemist/aichemist.db`. Schema: `projects` → `sessions` → `messages` → `tool_calls` (cascade deletes). Config stored as JSON in `projects.config`. Migrations in `electron/db.ts` are **append-only** — never modify existing SQL.

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
