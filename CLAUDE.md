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
| `agent/mcp-tools.ts` | MCP tool approval gate + `ask_user` tool (Claude) |
| `agent/approval.ts` | Approval promise map — `requestApproval` / `resolveApproval` |
| `agent/question.ts` | Question promise map — `requestQuestion` / `resolveQuestion` |

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
4. Main process streams events back: `SESSION_STATUS`, `SESSION_DELTA`, `SESSION_TOOL_CALL`, `SESSION_TOOL_RESULT`, `SESSION_APPROVAL_REQUIRED`, `SESSION_QUESTION_REQUIRED`, `SESSION_MESSAGE`
5. `useSessionEvents` hook (mounted once in `AppShell`) subscribes via `onSessionEvent()` and updates the Zustand session store
6. Approval-gated tools: main emits `SESSION_APPROVAL_REQUIRED`; UI shows approval dialog; renderer calls `ipc.approveToolCall()`
7. Interactive questions: main emits `SESSION_QUESTION_REQUIRED`; UI shows `QuestionCard`; renderer calls `ipc.answerQuestion()`

**Session history hydration:** `listSessions()` returns metadata only (`messages: []`). When `activeSessionId` changes, `useSessionHydration` (mounted in `App.tsx`) calls `ipc.getSession()` to load the full message history and calls `hydrateSession()` on the store. `mergeSessions()` deliberately preserves existing messages to avoid a race where a metadata refresh wipes hydrated history.

### State management (Zustand)

- `useSessionStore` — sessions, messages, streaming text, live tool calls, pending approvals, pending questions, terminal output, and `sessionAgents` (maps `sessionId → agentName | null`). Only `activeSessionId` is persisted (session data lives in SQLite). `sessionAgents` is restored from `session.agent` via `hydrateSession()` on navigation.
- `useProjectStore` — projects list, active project. Only `activeProjectId` is persisted.

### Database

SQLite at `~/.aichemist/aichemist.db`. Schema: `projects` → `sessions` → `messages` → `tool_calls` (cascade deletes). Config stored as JSON in `projects.config`. Notable `sessions` columns:

| Column | Purpose |
|---|---|
| `agent TEXT` | Selected agent name (nullable) |
| `sdk_session_id TEXT` | Claude SDK session ID — enables `resume:` across restarts |
| `copilot_session_id TEXT` | Copilot SDK session ID — enables `resumeSession()` across restarts |
| `copilot_session_agent TEXT` | Agent active when the Copilot SDK session was created — used to detect agent changes across restarts and force a fresh session |
| `copilot_session_mcp_fp TEXT` | Fingerprint of the AIchemist-managed MCP server map active when the Copilot SDK session was created — change forces a fresh session |
| `disabled_mcp_servers TEXT` | JSON array of AIchemist-managed MCP server names disabled for this session. Filtered out by `loadManagedMcpServers({ excludeNames })` before injection. |
| `acp_session_id TEXT` | ACP session id (returned by `session/new`). Persisted for diagnostics; v1 always creates a fresh ACP session per AIchemist session rather than calling `session/load`. |

Migrations in `electron/db.ts` are **append-only** — never modify existing SQL.

### Session provider lock

Each session is locked to a single provider (`"anthropic"`, `"copilot"`, or `"acp"`) at creation. Switching providers mid-session loses context because each provider has its own session id and cannot resume the other's state.

- **Creation:** `SessionTabBar` shows a split button — the main `+` creates with the project default, and the chevron opens a menu to explicitly pick Claude, Copilot, or ACP. The renderer calls `ipc.createSession(projectId, providerOverride?)`.
- **Empty state:** When a project has no sessions, `TimelinePanel` renders `EmptyStateNewSession` with three radio buttons (Claude / Copilot / ACP) plus a primary "Create a new session" button.
- **In-session:** `ModelPickerButton` filters its groups to the session's provider. ACP sessions are not multi-model — the agent is the model.
- **Runtime:** `AGENT_SEND` resolves `session.provider ?? project.config.provider` before dispatching to the matching runner in `electron/agent/runner.ts`.

### ACP (Agent Client Protocol) provider

`electron/agent/acp.ts` implements the third provider. AIchemist-UI is the ACP **client**; the agent runs as a subprocess over stdio configured via `ProjectConfig.acp_agent` (`{ command, args?, env?, cwd?, auth_method_id? }`).

- **Connection lifecycle:** one subprocess per `(projectPath, agentConfigFingerprint)` keyed in an in-process `connections` map. Multiple AIchemist sessions for the same project+agent share the connection; each gets its own ACP session id from `session/new`.
- **Event mapping:** `handleSessionUpdate` (exported, unit-tested in `acp.test.ts`) translates ACP `session/update` notifications into the same IPC events Claude/Copilot use — `agent_message_chunk` → `SESSION_DELTA`, `tool_call` → `saveToolCall` + `SESSION_TOOL_CALL`, `tool_call_update` → `updateToolCallStatus` + `SESSION_TOOL_RESULT`. ACP `ToolCallStatus` maps via `mapAcpStatus` (`pending → pending_approval`, `in_progress → approved`, `completed → complete`, `failed → error`).
- **Approval gate:** ACP `session/request_permission` flows through a new option-based path (`requestPermissionChoice` in `electron/agent/approval.ts`); the renderer's `ApprovalGate` renders one button per option when `permissionOptions` is present in the `PendingApproval`. `fs/write_text_file` is treated as a synthetic `fs_write` tool call and gated through `requiresApproval()` like a native Write/Edit.
- **Filesystem boundary:** `fs/read_text_file` is constrained to the project root via `realpathSync`. Both fs tools reject non-absolute paths.
- **Auth:** `initialize` response's `authMethods` is captured on the connection. If `session/new` fails with an auth-required error, the runner surfaces it with the agent's method list — set `acp_agent.auth_method_id` manually (no auth flow UI in v1).
- **Out of scope (v1):** `session/load` resume, terminal capability, image/resource content blocks in prompts, plan UI, traces, skills/MCP injection, agent picker, cancel button.
- **Right-panel guards:** `SkillsPanel`, `MemoryPanel`, and `McpServersPanel` show "not available for ACP" placeholders when `useActiveSessionProvider() === "acp"`.

---

## Traces (transcript-based)

The Traces tab does **not** use an in-memory tracer. Instead, both providers write structured session transcripts to disk, and we parse them on demand (non-blocking reads) into `TraceSpan[]`.

| Provider | Transcript path | Parser |
|---|---|---|
| Claude | `~/.claude/projects/<encoded-cwd>/<sdk_session_id>.jsonl` | `electron/claude-transcript.ts` |
| Copilot | `~/.copilot/session-state/<copilot_session_id>/events.jsonl` | `electron/copilot-transcript.ts` |

### IPC surface

- **`GET_TRACES({ sessionId })`** in `electron/main.ts` — dispatches by provider: looks up `sessions.sdk_session_id` (Claude) or `sessions.copilot_session_id` (Copilot) and parses the corresponding file.
- **`TRACE_BIND_TRANSCRIPT({ sessionId })`** — sets up a `chokidar` watcher on the transcript file and streams incremental spans via `SESSION_TRACE_UPDATE`. The `TracesPanel` calls this when the tab opens.

### Copilot turn grouping — anchor on `interactionId`, not `turnId`

Copilot emits a cascade of inner `assistant.turn_start` / `assistant.turn_end` pairs per user prompt — one per tool-call batch. All inner turns for a single user message share the same `interactionId`, while `turnId` increments per inner step.

`copilotEventsToSpans()` anchors turn spans on `interactionId` so a single user prompt becomes a single user-visible turn that wraps the full chain of reasoning + tool calls:

- Turn span id: `turn:copilot:<sid>:<interactionId>`
- Tool spans use `currentTurnSpanId` as `parentId` regardless of which inner `turn_start` they arrived under
- `outputTokens` and `reasoningText` from all inner `assistant.message` events with the same `interactionId` accumulate onto the single turn
- The previous interaction's turn finalizes to `success` when a new `user.message` with a different `interactionId` appears
- End-of-stream promotes the last turn to `success` iff it saw at least one `assistant.turn_end`

**If you add a new Copilot event type** that carries an `interactionId`, route it through the current-interaction map rather than `currentTurnId`, or the tab will regress to one-row-per-inner-turn.

### Claude transcripts

Claude's `.jsonl` format has one line per SDK message. `claude-transcript.ts` builds turns from `user`/`assistant` blocks and tool spans from `tool_use` / `tool_result` content items. Stable ids: `turn:claude:<sdk_session_id>:<messageIndex>` and `tool:<tool_use_id>`.

### Session ID lookup

Traces only appear once the session has run at least one turn — that's when `sdk_session_id` / `copilot_session_id` is first populated. Before then, `GET_TRACES` returns an empty array. Don't add a fallback that synthesizes spans from `tool_calls` rows; the transcript is the source of truth.

---

## Agent Selection

The app has a VS Code-style **agent picker** in the input bar (`src/components/session/AgentPickerButton.tsx`). It replaces the old Agents tab (which is now the **Skills** tab, showing only skills/tools from `.agents/skills/`).

### How it works

1. User clicks the agent picker button next to the message input.
2. The dropdown loads available agents (lazy, cached after first fetch) via `ipc.getClaudeAgents()` or `ipc.getCopilotAgents()` depending on the active provider.
3. Selecting an agent calls `ipc.updateSessionAgent(sessionId, agentName)` — persisted to `sessions.agent` in SQLite.
4. On the next `agentSend`, the runner picks up the agent and activates it:
   - **Claude:** `options.agent = agentName` passed to Claude Code SDK (for SDK built-ins) or the agent file body injected as `systemPrompt`
   - **Copilot:** agent file body injected as `systemMessage: { mode: "replace" }` in the session config. If the agent changed since the last turn, the old SDK session is discarded so the new system message takes effect from turn 1. Lookup order: Copilot agent files → Claude agent files (cross-provider fallback for agents selected via Command Palette).
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

`src/components/session/SkillsPanel.tsx` lists skills discovered from three source tiers (priority order). The exact paths depend on the active session's provider:

| Tier | Claude session | Copilot session |
|---|---|---|
| **Project** | `<projectPath>/.agents/skills/*/` | `<projectPath>/.agents/skills/*/` |
| **Global** | `~/.claude/skills/*/` | `~/.agents/skills/*/` |
| **Plugin** | `~/.claude/plugins/installed_plugins.json` → each install's `skills/*/SKILL.md` | `~/.copilot/installed-plugins/<scope>/<plugin>/skills/*/SKILL.md` |

Skills with a higher-priority source suppress same-named skills from lower tiers. `SkillInfo.source` controls panel behaviour:

- **`"user"` skills** (project/global) — show pencil icon (editable); click opens `SkillEditorModal` in edit mode.
- **`"plugin"` skills** — pencil icon hidden (read-only); click opens viewer instead.

Each card supports three interactions:

- **Click card body** — toggles the skill on/off for the active session (persisted via `ipc.updateSessionSkills`).
- **Eye icon** (hover) — opens `SkillEditorModal` with `readOnly=true` to view the skill's rendered markdown.
- **Pencil icon** (hover, user skills only) — opens `SkillEditorModal` in edit mode to modify `SKILL.md`.

A **New Skill** button at the bottom opens `SkillEditorModal` with `skill=null` (create mode).

### Filtering & search

Above the skill list, the panel exposes:

- A **search input** that case-insensitively matches against the skill's `name`, `description`, and `plugin` fields.
- A row of **source filter chips** (`project` / `global` / `plugin`), each toggleable with a count of skills in that source. All sources are enabled by default. Both filters compose (search AND chip filter).
- The empty state distinguishes between "no skills installed", "no skills match the filters", and `No skills match "<query>"`.

The info (i) tooltip describing skill discovery paths lives on the right-panel header beam (next to the SKILLS title), exported from `SkillsPanel.tsx` as `SkillsHeaderInfo` and rendered by `ContextPanel.tsx`.

### Skill discovery implementation

`scanSkillsDir()` in `electron/main.ts` reads skill descriptions from `SKILL.md` frontmatter first (falls back to `README.md`). `scanPluginSkills()` reads `~/.claude/plugins/installed_plugins.json`, picks the most-recently-updated install per plugin, and walks `<installPath>/skills/*/SKILL.md`. `scanCopilotPluginSkills()` walks `~/.copilot/installed-plugins/<scope>/<plugin>/skills/*/SKILL.md` directly (no manifest file).

`LIST_SKILLS` accepts `{ projectPath, provider }` (or a bare `projectPath` string for back-compat — treated as Claude). The handler branches on `provider` to choose between the Claude and Copilot global/plugin scanners. The renderer (`SkillsPanel`) passes `useActiveSessionProvider()` so the listing always matches the active session's provider lock.

`buildSkillsContext()` in `electron/agent/skills.ts` resolves SKILL.md content for active skills. It searches **all** known locations in priority order (project → Claude global → Copilot global → Claude plugins → Copilot plugins) so a toggled skill is injectable regardless of which provider runs the turn. Two module-level lazy caches (`pluginSkillPathCache`, `copilotPluginSkillPathCache`) map skill name → dir path; call `_resetPluginSkillCache()` in tests to reset both.

### Slash command palette

Typing `/` in the message input opens a floating popover listing skills and built-in actions. Selecting a skill adds a one-shot badge (applied to that message only, not persisted to the session). Built-in actions: `/new`, `/clear`, `/help`, `/agent`. See `src/components/session/SlashCommandPopover.tsx` and `InputBarInner` in `src/components/session/TimelinePanel.tsx`.

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

### Tooltips

Use `<WithTooltip label="…">` from `src/components/ui/with-tooltip.tsx` for hover hints on interactive controls. It wraps the Base UI `Tooltip` primitives via the `render` prop (Base UI does not support `asChild`). Pair `label` with `aria-label` (or visible text) on the inner element so the control stays accessible to screen readers and discoverable in tests via `getByLabelText`. Avoid native `title=` on the same element — it would race with the Tooltip and create a duplicate browser tooltip. The global `TooltipProvider` is mounted in `src/App.tsx`.

### Provider-aware right panel

The right-side context panels (Skills, MCP, Memory) filter their content to the active session's provider, matching the per-session provider lock. Use `useActiveSessionProvider()` from `src/lib/hooks/useActiveSessionProvider.ts` — it resolves the session's `provider` and falls back to the active project's default for legacy sessions, returning `"anthropic" | "copilot" | null`.

- **MCP** (`McpServersPanel`) filters its rows by `source`: Claude sessions see `claude`/`both`, Copilot sees `copilot`/`both`. AIchemist-managed servers (`source: "aichemist"`) are passed through to **both** providers.
- **Memory** (`MemoryPanel`) is Claude-only — Copilot sessions render a "not available" placeholder and skip the IPC fetch entirely.
- **Skills** (`SkillsPanel`) passes the provider through to `LIST_SKILLS` so the backend scans the right global / plugin paths (see Skills Panel section).

---

## AIchemist-managed MCP servers

VS Code-style editor-owned MCP config. AIchemist maintains its own MCP server list at `~/.aichemist/mcp.json` and injects it per-session into both Claude and Copilot SDK runs — without writing to the SDKs' own global config files (`~/.claude.json`, `~/.copilot/mcp-config.json`).

| Layer | Detail |
|---|---|
| Config file | `~/.aichemist/mcp.json` (scope id `aichemist-global` in `electron/mcp-config.ts`) |
| Loader / adapters | `electron/agent/mcp-managed.ts` — `loadManagedMcpServers()`, `toClaudeMcpServers()`, `toCopilotMcpServers()`, `fingerprintManaged()` |
| Reserved name | `aichemist-tools` is the in-process approval-gated server. `loadManagedMcpServers()` strips it defensively; the Claude runner spreads `{...managed, "aichemist-tools": mcpServer}` so the literal key always wins. |
| Claude injection | `electron/agent/claude.ts` spreads managed servers into `query({ mcpServers })` before `aichemist-tools`. |
| Copilot injection | `electron/agent/copilot.ts` adds them to `SessionConfig.mcpServers`. `MCPServerConfig` typed import from `@github/copilot-sdk` is required for the adapter return type. |
| Copilot invalidation | `client.resumeSession()` does NOT honour an updated `mcpServers`. A stable fingerprint is stored in `sessions.copilot_session_mcp_fp`; on each turn, an agent change OR fingerprint change forces a fresh `createSession`. |
| Panel | `McpServersPanel` shows a violet "AIchemist" badge for `source === "aichemist"`. The "AIchemist" tab in `McpConfigEditorDialog` is the default scope. |
| Health probing | `electron/agent/mcp-probe.ts` actively connects to each managed server (stdio/HTTP/SSE), runs `tools/list`, and surfaces `{ connected, tools, error }` on each row. Cached 30s by fingerprint of the unfiltered managed map; `force: true` (`MCP_PROBE_MANAGED` IPC, used by the refresh button) bypasses the cache. Stdio probes have a 4-parallel concurrency cap to avoid spawn storms. The SDK loader is injected via `_setSdkLoader` for tests — see `mcp-probe.test.ts`. |
| Per-session disable | Toggle in the panel persists names to `sessions.disabled_mcp_servers` via `MCP_TOGGLE_SESSION_SERVER` and `setDisabledMcpServers`. Both runners read the disabled set per turn and pass it via `loadManagedMcpServers({ excludeNames })`. Claude picks up the new map per-turn (no cache work needed). For Copilot, the disabled set is filtered BEFORE `fingerprintManaged()` so toggling naturally invalidates the cached SDK session. |
| No project-level managed scope | Intentional — projects should use the de-facto `.mcp.json` at the project root, which both SDKs already discover. |

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

### Claude Code SDK — Streaming vs Extended Thinking

The Claude Agent SDK has a **known limitation**: enabling extended thinking (`thinking: { type: "enabled" }` or `maxThinkingTokens`) **disables all `StreamEvent` messages**. This means text streaming (real-time deltas) stops working entirely when thinking is enabled.

**Do NOT add a `thinking` option** to the `query()` call in `electron/agent/claude.ts`. It will silently break streaming text, making the UI appear frozen until the full response is ready.

The `Reasoning` component is wired up for **Copilot only**, which properly supports `assistant.reasoning_delta` streaming without any trade-offs.

### Claude Code SDK — `PreToolUse` hook for approval gating

Claude prefers its **native tools** (`Write`, `Edit`, `Bash`, `WebFetch`) over our custom MCP tools. These native tools bypass the MCP approval gate in `mcp-tools.ts`. The `PreToolUse` hook in `query()` options intercepts ALL native tool calls before execution — we check `requiresApproval()` and pause with `requestApproval()` when needed.

MCP tools (`mcp__aichemist-tools__*`) are explicitly skipped in the hook (they handle approval themselves). Read-only tools (`Read`, `Glob`, `LS`) always return `approve` immediately.

### Copilot SDK — `customAgents` vs `systemMessage`

`customAgents` in Copilot sessions are **sub-agent delegation configs** — the parent Copilot agent decides when to delegate to them based on inference. They are NOT a replacement for the session system prompt.

To make a user-selected agent's instructions the primary context, use `systemMessage: { mode: "replace", content: agentBody }` in the `createSession`/`resumeSession` config. When the agent changes between turns, the cached Copilot SDK session must be discarded (delete from `copilotSessionIds` **and** NULL out `copilot_session_id`/`copilot_session_agent` in the DB) so the next turn creates a fresh session with the new system message — `resumeSession` does not update the system message of an existing session.

### Copilot SDK — Agent tracking normalization

`copilot.ts` tracks the last agent used per session in `copilotSessionIds` (keyed `agent:${sessionId}`) **and** in `sessions.copilot_session_agent` in the DB. The in-memory map is the fast path within a single app run; the DB values are read once per session on first access (via the `seededFromDb` gate) so session continuity survives restarts. When comparing to detect an agent change, **always normalize both sides to the same type**:

```typescript
// ✅ Correct — both sides normalize undefined to ""
const normalizedAgent = agent ?? "";
const lastAgent = copilotSessionIds.get(lastAgentKey) ?? "";
if (normalizedAgent !== lastAgent) { ... }
copilotSessionIds.set(lastAgentKey, normalizedAgent);

// ❌ Wrong — undefined !== "" is always true, resetting the session every turn
const lastAgent = copilotSessionIds.get(lastAgentKey) ?? null;
if (agent !== lastAgent) { ... }       // undefined !== "" → session deleted!
copilotSessionIds.set(lastAgentKey, agent ?? "");
```

The asymmetry silently destroys conversation history on every turn when no agent is selected.

### Tool call persistence — placeholder message pattern

Tool calls are stored in the `tool_calls` table with a `message_id NOT NULL` FK. The assistant message is created **before** `provider.run()` so tool calls have a valid FK to reference immediately:

```typescript
// runner.ts pattern
const placeholder = createPlaceholderMessage(db, { sessionId, agent });
// messageId threaded into provider params...
const text = await provider.run({ ...params, messageId: placeholder.id });
const toolCalls = loadToolCallsForMessage(db, placeholder.id);
if (text.trim() || toolCalls.length > 0) {
  updateMessageContent(db, placeholder.id, text);
} else {
  db.prepare("DELETE FROM messages WHERE id = ?").run(placeholder.id);
}
```

Each tool call goes through status transitions: `pending_approval` → `approved` / `rejected` → `complete` / `error`. `saveToolCall()` inserts at start; `updateToolCallStatus()` updates as it progresses.

### Interactive Questions — `ask_user` tool

Both Claude and Copilot expose an `ask_user` tool that pauses the agent and shows a `QuestionCard` in the UI.

**Flow:**
1. Agent calls `ask_user({ question, options?, placeholder? })`
2. `electron/agent/question.ts` stores a `Promise` resolve function keyed by `questionId` and emits `SESSION_QUESTION_REQUIRED`
3. `useSessionEvents` adds a `PendingQuestion` to `useSessionStore` with a `resolve` that calls `ipc.answerQuestion()`
4. `TimelinePanel` renders a `QuestionCard` per pending question
5. User submits → `resolve(answer)` → `ipc.answerQuestion(questionId, answer)` → `ipcMain` calls `resolveQuestion()` → Promise resolves → agent continues

**Claude:** registered as an MCP tool in `mcp-tools.ts`. The system prompt in `claude.ts` instructs Claude to use `ask_user` instead of the native `AskUserQuestion` CLI tool (which requires an interactive terminal TUI unavailable in Electron).

**Copilot:** registered via `defineTool` in `copilot.ts`. The system prompt instructs Copilot to use `ask_user` instead of asking questions in plain text, and to always supply `options` when there are distinct alternatives.

**Cleanup:** `clearPendingQuestions(sessionId)` is called on `SESSION_STATUS: "running"` (new turn) to discard orphaned cards.

### Session status persistence and crash recovery

`sessions.status` is persisted to SQLite (`idle` / `running` / `error`) via `updateSessionStatus()` called in `runner.ts` at each transition. On `app.whenReady()`, `recoverStaleSessionStatuses()` marks any session stuck in `"running"` as `"error"` — this handles crashes and force-quits where the normal idle/error transition never ran.

If you add a new IPC handler that starts an agent turn, always call `updateSessionStatus(db, sessionId, "running")` at the start and `"idle"` or `"error"` at the end so crash recovery works correctly.

### LIST_DIRECTORY — filtering and cap

The `LIST_DIRECTORY` IPC handler in `main.ts` applies two safeguards before returning entries:

1. **`IGNORED_DIR_NAMES`** — a `Set` of directory names (`node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `.turbo`) that are filtered out before counting or returning.
2. **`MAX_DIR_ENTRIES = 500`** — if more than 500 entries remain after filtering, the list is truncated and `{ entries, truncated: true }` is returned. The caller (agent tool) should surface this to the model so it doesn't assume the listing is complete.

Always check the `truncated` flag in any code that consumes `LIST_DIRECTORY` results.
