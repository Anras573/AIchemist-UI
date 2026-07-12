# AIchemist UI — Implementation Plan

**Date:** 2026-03-12
**Status:** **Superseded**

> **Note (2026-03-24):** This plan was written for a Tauri + Rust implementation that was
> never built. The app was shipped on **Electron + Node.js** instead. Refer to `CLAUDE.md` for
> the current architecture and `notes/plans/2026-03-24-skills-otel-edit.md` for active planning.

**Design doc:** `notes/plans/2026-03-12-agent-ui-design.md`
**MVP definition:** Streaming LLM responses + core filesystem/shell tools + approval gates

---

## Decisions Made

| Question | Decision |
|---|---|
| Session persistence | SQLite via `rusqlite` at `~/.aichemist/sessions.db` |
| API key storage | Env vars (process env first, then `~/.aichemist/.env` via `dotenvy`) |
| MVP scope | Phase 4 complete = MVP (streaming + tools + approval gates) |

---

## Phase 1 — Foundation

*Goal: app launches with correct layout, all UI primitives available.*

### 1.1 Install frontend dependencies

```bash
bun add ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/openai-compatible zod
bunx shadcn@latest init               # sets up shadcn/ui + tailwind
bunx ai-elements@latest add conversation message tool confirmation shimmer
bunx ai-elements@latest add chain-of-thought model-selector prompt-input
bunx ai-elements@latest add file-tree terminal task queue
```

**After installing AI Elements, add the `@/` path alias** — required for all AI Elements imports:

`vite.config.ts`:
```ts
import path from "path";
resolve: { alias: { "@": path.resolve(__dirname, "./src") } }
```

`tsconfig.json` `compilerOptions`:
```json
"baseUrl": ".", "paths": { "@/*": ["./src/*"] }
```

### 1.2 Add Rust dependencies

`Cargo.toml`:
```toml
tokio = { version = "1", features = ["full"] }   # async runtime (explicit)
rusqlite = { version = "0.32", features = ["bundled"] }
dotenvy = "0.15"
uuid = { version = "1", features = ["v4"] }
serde = { version = "1", features = ["derive"] }  # already present
serde_json = "1"                                   # already present
```

### 1.3 App shell layout

**Files to create:**
- `src/components/layout/AppShell.tsx` — root layout: sidebar + workspace area
- `src/components/layout/ProjectSidebar.tsx` — collapsible sidebar (~240px → icon rail)
- `src/components/layout/WorkspaceView.tsx` — session tab bar + split pane
- `src/components/layout/SplitPane.tsx` — resizable left/right panels (60/40 default)
- `src/components/layout/CommandPalette.tsx` — `Cmd+K` overlay using `cmdk`

**Routing:** No router needed. Active project + active session are global state. Use Zustand or React context.

### 1.4 TypeScript types

`src/types/index.ts` — shared types matching the data model in the design doc:
```ts
Project, ProjectConfig, ApprovalRule
Session, SessionStatus
Message, MessageRole
ToolCall, ToolCallStatus
ToolDefinition, ToolCategory
Provider
```

### 1.5 Tauri capabilities update

Add to `src-tauri/capabilities/default.json`:
```json
"fs:read-all", "fs:write-all", "shell:execute"
```
(exact permission identifiers depend on which Tauri plugins are added in Phase 3)

**Milestone check:** `bun run tauri dev` opens a window with sidebar + split pane layout, static/empty state.

---

## Phase 2 — Project Management

*Goal: open a folder as a project, persist project list, read/write `.aichemist/config.json`.*

### 2.1 Rust: project store

`src-tauri/src/projects.rs`:

| Command | Signature | Description |
|---|---|---|
| `add_project` | `(path: String) -> Result<Project>` | Opens a folder, creates `.aichemist/config.json` if absent, returns Project |
| `list_projects` | `() -> Result<Vec<Project>>` | Returns all known projects from SQLite |
| `remove_project` | `(id: String) -> Result<()>` | Removes from registry (does not delete folder) |
| `get_project_config` | `(id: String) -> Result<ProjectConfig>` | Reads `.aichemist/config.json` |
| `save_project_config` | `(id: String, config: ProjectConfig) -> Result<()>` | Writes `.aichemist/config.json` |

### 2.2 SQLite: project table

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
```

DB file lives at `~/.aichemist/aichemist.db` (created on first launch).

### 2.3 React: project UI

- `ProjectSidebar` renders `ProjectList` from `list_projects` on mount
- "Add Project" button opens OS folder picker (Tauri `open` dialog)
- `CommandPalette` (`Cmd+K`) searches project list, switches active project
- Active project stored in global state (`useProjectStore`)

**Milestone check:** Can open a folder, see it in sidebar, switch between projects, remove projects.

---

## Phase 3 — Session Management

*Goal: create sessions within a project, tabs persist in SQLite, status indicators work.*

### 3.1 Rust: session registry

`src-tauri/src/sessions.rs`:

| Command | Signature | Description |
|---|---|---|
| `create_session` | `(project_id: String) -> Result<Session>` | Creates session row in SQLite, returns Session |
| `list_sessions` | `(project_id: String) -> Result<Vec<Session>>` | Sessions for a project, ordered by created_at |
| `get_session` | `(session_id: String) -> Result<Session>` | Full session with messages |
| `delete_session` | `(session_id: String) -> Result<()>` | Hard delete |

### 3.2 SQLite: session + message tables

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New session',
  status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  name TEXT NOT NULL,
  args TEXT NOT NULL,        -- JSON
  result TEXT,               -- JSON, nullable until complete
  status TEXT NOT NULL,
  category TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
```

### 3.3 Tauri events for session state

Rust emits these events via `app_handle.emit()`:

| Event | Payload | When |
|---|---|---|
| `session:status` | `{ session_id, status }` | Status changes |
| `session:delta` | `{ session_id, text_delta }` | Streaming text chunk |
| `session:message` | `{ session_id, message }` | New message finalised |
| `session:tool_call` | `{ session_id, tool_call }` | Tool call started |
| `session:tool_result` | `{ session_id, tool_call }` | Tool call completed |
| `session:approval_required` | `{ session_id, tool_call }` | Needs user decision |

### 3.4 React: session UI

- `SessionTabBar` — horizontal tabs, each shows title + status dot (pulsing=running, amber=waiting, red=error)
- `TimelinePanel` — renders `Message` (AI Elements) + `Tool` cards per session
- `MessageInput` (AI Elements `PromptInput`) — disabled while session is `running` or `waiting_approval`
- Global `useSessionStore` subscribes to Tauri events on mount, unsubscribes on unmount

**Milestone check:** Can create sessions per project, tabs persist across app restarts, status dots update.

---

## Phase 4 — LLM Integration (MVP unlock)

*Goal: real streaming LLM responses appear in the timeline. This completes the core loop.*

### 4.1 API key resolution (Rust)

`src-tauri/src/config.rs`:

```rust
// Resolution order:
// 1. Process environment: ANTHROPIC_API_KEY, OPENAI_API_KEY
// 2. ~/.aichemist/.env (loaded via dotenvy on startup)
// 3. Returns None if not found — frontend shows "configure API key" prompt
```

Command: `get_api_key(provider: String) -> Result<Option<String>>`

Load `.env` once at app startup in `lib.rs` before the Tauri builder runs:
```rust
let _ = dotenvy::from_path(home_dir().join(".aichemist/.env"));
```

### 4.2 Vercel AI SDK: provider factory

`src/lib/ai/providers.ts`:
```ts
export function buildModel(config: ProjectConfig, apiKey?: string): LanguageModel
```

Supports `anthropic`, `openai`, `ollama`. Reads API key via `invoke<string | null>("get_api_key", { provider })`.

### 4.3 Vercel AI SDK: agent loop

`src/lib/ai/agent.ts`:

```ts
export async function runAgentTurn(
  session: Session,
  userMessage: string,
  tools: Record<string, CoreTool>,
  onEvent: (event: AgentEvent) => void,
): Promise<void>
```

- Calls `streamText` with `stopWhen: stepCountIs(20)` (v6 API — `maxSteps` is deprecated)
- Iterates `result.fullStream` — emits `AgentEvent` for each part type
- On `tool-call` part: calls `invoke("request_tool_execution", { session_id, tool_call })` and awaits result
- On `text-delta`: emits live streaming event to React state
- Stores final messages via `invoke("save_message", ...)`

### 4.4 Core tool definitions (TypeScript side)

`src/lib/ai/tools.ts` — wraps each Rust command as an AI SDK `tool()`:

```ts
// Note: v6 API uses `inputSchema` not `parameters` (deprecated)
export const coreTools = {
  read_file:       tool({ inputSchema: z.object({...}), execute: () => invoke("read_file", ...) }),
  list_directory:  tool({ inputSchema: z.object({...}), execute: () => invoke("list_directory", ...) }),
  write_file:      tool({ inputSchema: z.object({...}), execute: () => invoke("write_file", ...) }),
  delete_file:     tool({ inputSchema: z.object({...}), execute: () => invoke("delete_file", ...) }),
  bash:            tool({ inputSchema: z.object({...}), execute: () => invoke("execute_bash", ...) }),
  web_search:      tool({ inputSchema: z.object({...}), execute: () => invoke("web_search", ...) }),
  web_fetch:       tool({ inputSchema: z.object({...}), execute: () => invoke("web_fetch", ...) }),
}
```

### 4.5 React: streaming display

- `AssistantMessage` uses AI Elements `Message` + `Shimmer` while streaming
- `Chain of Thought` component wraps reasoning/thinking tokens if the model emits them
- `MessageInput` `onSubmit` → calls `runAgentTurn()` → sets session status to `running`

**Milestone check — MVP:** Type a message, get a real streaming response from Claude/GPT, see it appear live in the timeline. ✓

---

## Phase 5 — Core Tools + Approval Gates (MVP complete)

*Goal: agent can read/write files and run shell commands, with configurable approval.*

### 5.1 Rust: tool execution commands

`src-tauri/src/tools.rs`:

| Command | Args | Description |
|---|---|---|
| `read_file` | `path: String` | Read file contents |
| `write_file` | `path: String, content: String` | Write/overwrite file |
| `delete_file` | `path: String` | Delete file |
| `list_directory` | `path: String` | List dir contents |
| `execute_bash` | `command: String, cwd: String` | Run shell command, capture stdout/stderr |
| `web_search` | `query: String` | Web search (via external API or scraping) |
| `web_fetch` | `url: String` | Fetch URL content |

### 5.2 Approval system (Rust)

`src-tauri/src/approvals.rs`:

**Flow:**
1. TypeScript calls `invoke("request_tool_execution", { session_id, tool_call })`
2. Rust checks `ProjectConfig.approval_rules` for the tool's category
3. **If approved:** executes immediately, returns result
4. **If requires approval:** adds to in-memory `ApprovalQueue`, emits `session:approval_required`, blocks until resolved
5. TypeScript/React waits for the return value (the `invoke` call is awaited)
6. User approves/rejects via `invoke("resolve_approval", { tool_call_id, approved: bool })`
7. `request_tool_execution` unblocks and returns result or rejection

```rust
// Approval resolution uses a tokio oneshot channel per pending tool call
// HashMap<ToolCallId, oneshot::Sender<bool>> held in AppState
```

### 5.3 React: approval gate UI

- AI Elements `Confirmation` component renders inline in `TimelinePanel`
- Appears when `session:approval_required` event fires
- Shows tool name, category badge, args preview
- "Approve" → `invoke("resolve_approval", { id, approved: true })`
- "Reject" → `invoke("resolve_approval", { id, approved: false })`
- `MessageInput` is disabled while approval is pending

### 5.4 Approval config UI

`src/components/settings/ProjectSettings.tsx`:
- Per-project settings panel (accessible from sidebar)
- `approval_mode` toggle: All / None / Custom
- Per-category toggles when mode is Custom

**Milestone check:** Agent reads a file, shows the tool call card, optionally asks for approval, displays result. bash commands ask for approval before running. ✓

---

## Phase 6 — Context Panel

*Goal: right panel shows live file tree, terminal output, and auto-switches on tool calls.*

### 6.1 FileTree panel

- AI Elements `FileTree` component
- Populated via `list_directory` on the project root
- Refreshes when `session:tool_result` fires for a `filesystem` category tool
- Clicking a file opens it in a read-only code view

### 6.2 Terminal panel

- AI Elements `Terminal` component
- Receives stdout/stderr lines from `execute_bash` tool results
- Appends per session (each session has its own terminal buffer)
- Read-only mirror — this is not an interactive terminal

### 6.3 Auto-switching logic

`ContextPanel` watches `session:tool_call` events:
```
filesystem tool called → switch to Files tab
shell tool called      → switch to Terminal tab
web tool called        → switch to Web tab (future)
```
User can manually switch tabs at any time; auto-switch only fires if no manual override since last tool call.

**Milestone check:** File tree updates after writes, terminal shows bash output live.

---

## Phase 7 — Navigation & Polish

*Goal: fast project switching, background session badges, model selector.*

### 7.1 Background session notifications

- `ProjectItem` in sidebar shows badge count of `running` + `waiting_approval` sessions
- Subscribes to all sessions' status events, not just the active one
- Clicking a badge navigates directly to the session needing attention

### 7.2 Cmd+K command palette

- `cmdk` library
- Sections: Projects, Sessions (of active project), Recent sessions (across all projects)
- `↑↓` navigate, `Enter` switches, `Esc` closes
- Triggered by `Cmd+K` global keyboard shortcut registered via Tauri

### 7.3 Model selector

- AI Elements `ModelSelector` component in `ProjectSettings`
- Lists models per provider (hardcoded known models + free text for custom)
- Persists to `ProjectConfig`

### 7.4 Custom tools

- `ProjectSettings` has a "Custom Tools" section
- Users paste a JSON Schema tool definition (with `execute_url` for HTTP tools)
- Stored in `ProjectConfig.custom_tools`
- Loaded alongside `coreTools` in `runAgentTurn`

---

## File Structure (target state after all phases)

```
src/
  components/
    layout/
      AppShell.tsx
      ProjectSidebar.tsx
      WorkspaceView.tsx
      SplitPane.tsx
      CommandPalette.tsx
    session/
      SessionTabBar.tsx
      TimelinePanel.tsx
      ContextPanel.tsx
    settings/
      ProjectSettings.tsx
  lib/
    ai/
      agent.ts          # runAgentTurn, AgentEvent types
      tools.ts          # coreTools definitions (AI SDK tool() wrappers)
      providers.ts      # buildModel factory
    store/
      useProjectStore.ts
      useSessionStore.ts
  types/
    index.ts

src-tauri/src/
  lib.rs                # Tauri builder, command registration
  main.rs               # Binary entry point
  db.rs                 # SQLite init, migrations
  projects.rs           # Project CRUD commands
  sessions.rs           # Session CRUD + event emission
  tools.rs              # Tool execution commands
  approvals.rs          # Approval queue + resolution
  config.rs             # API key resolution (env + .env file)

notes/plans/
  2026-03-12-agent-ui-design.md
  2026-03-12-implementation-plan.md
```

---

## Build Order Summary

| Phase | What you get | MVP? |
|---|---|---|
| 1 — Foundation | App launches, layout renders | No |
| 2 — Projects | Open folders, persist project list | No |
| 3 — Sessions | Create/switch sessions, tabs persist | No |
| 4 — LLM | Real streaming responses from Claude/GPT | ✓ MVP unlock |
| 5 — Tools + Approval | Agent can read/write files, bash, with gates | ✓ MVP complete |
| 6 — Context Panel | File tree + terminal panel live-update | Post-MVP |
| 7 — Polish | Cmd+K, badges, model selector, custom tools | Post-MVP |

---

## Open Questions (carry forward)

1. **Web search tool** — which API? (Tavily, Brave Search, or a scraping approach?)
2. **Web context panel** — full embedded WebView or rendered markdown/text?
3. **Custom tool execution** — HTTP calls only, or allow arbitrary TypeScript eval?
4. **Ollama discovery** — auto-detect running instance, or manual URL config?
5. **CSP hardening** — `tauri.conf.json` currently has `"csp": null`; needs `connect-src` entries per provider before production
