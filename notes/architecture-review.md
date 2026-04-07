# AIchemist-UI Architecture Review

> Reviewed: 2026-04-07  
> Overall Grade: **B+**

---

## 1. Overall Structure — Two-Process Electron Model

```
AIchemist-UI (Electron App)
├── Main Process (Node.js + Electron)
│   ├── electron/main.ts         — Window creation, IPC handler registry
│   ├── electron/db.ts           — SQLite init & migrations
│   ├── electron/config.ts       — Env var loading, API key resolution
│   ├── electron/projects.ts     — Project CRUD (DB + per-project JSON config)
│   ├── electron/sessions.ts     — Session/message CRUD
│   ├── electron/agent/
│   │   ├── runner.ts            — Provider dispatcher
│   │   ├── claude.ts            — Claude Code SDK integration
│   │   ├── copilot.ts           — GitHub Copilot SDK integration
│   │   ├── mcp-tools.ts         — In-process MCP server (approval-gated tools)
│   │   ├── approval.ts          — Promise-based approval gate
│   │   └── question.ts          — Interactive question promise map
│   └── electron/preload.ts      — contextBridge → typed window.electronAPI
│
└── Renderer Process (React 19 + TypeScript)
    ├── src/App.tsx               — Root component (hydration setup)
    ├── src/main.tsx              — React entry point
    ├── src/lib/
    │   ├── ipc.ts                — Typed wrapper over window.electronAPI
    │   ├── store/
    │   │   ├── useSessionStore.ts — Session/message/streaming state
    │   │   └── useProjectStore.ts — Project list + active project
    │   └── hooks/
    │       ├── useSessionEvents.ts    — IPC event subscription hub
    │       ├── useSessionHydration.ts — Lazy message history loading
    │       └── useAgentTurn.ts        — User message dispatch
    └── src/components/
        ├── layout/               — AppShell, TitleBar, ProjectSidebar
        ├── session/              — Chat, timeline, tools, approval UI
        ├── ai-elements/          — AI Elements wrappers
        └── ui/                   — Shadcn/UI + custom primitives
```

**Key design principle:**
- **Main process** = stateful backend: database, API clients, agent execution, file I/O
- **Renderer** = UI state machine: read-only copy of session data, driven by push events
- **Source of truth** = SQLite (projects, sessions, messages) + provider SDKs (session continuity)
- **Communication** = IPC: renderer calls via `ipcMain.handle()` (req/resp), main pushes via `webContents.send()` (events)

---

## 2. IPC Layer

### Architecture

```
Renderer:
  useAgentTurn.sendMessage()
  └─> ipc.agentSend({ sessionId, prompt })
      └─> window.electronAPI.agentSend(...)
          └─> ipcRenderer.invoke(CH.AGENT_SEND, args)

Main:
  ipcMain.handle(CH.AGENT_SEND, async (_event, args) => {
    await runAgentTurn(args);
  });

Push events (main → renderer):
  webContents.send(CH.SESSION_STATUS, { session_id, status })
  webContents.send(CH.SESSION_DELTA, { session_id, text_delta })
  webContents.send(CH.SESSION_TOOL_CALL, { ... })
  webContents.send(CH.SESSION_APPROVAL_REQUIRED, { ... })
  └─> useSessionEvents() → Zustand store
```

### Channel Contract

- `electron/ipc-channels.ts` — single source of truth for all channel name constants
- Request/response: `ipcMain.handle` + `ipcRenderer.invoke` (file I/O, DB queries, API calls)
- Push events: `webContents.send` + `ipcRenderer.on` (streaming deltas, tool calls, approvals)

### Typed Surface

- `electron/preload.ts` exposes `ElectronAPI` interface
- `src/lib/ipc.ts` wraps each method — components call `ipc.saveMessage()` not `window.electronAPI.saveMessage()`

### Notes

- IPC listener cleanup handled: `preload.ts` tracks wrapped listeners in a Map so `off()` removes the exact function
- PATH augmentation on macOS: `electron/config.ts` injects `/opt/homebrew/bin` etc. before spawning child processes (critical for `claude` CLI)
- Binary file detection: `READ_FILE` scans first 8 KB for null bytes; binary files are rejected

---

## 3. State Management — Zustand

### `useSessionStore`

Ephemeral per-turn state (NOT persisted, except `activeSessionId`):

| Field | Purpose |
|---|---|
| `sessions` | Session metadata + messages keyed by ID |
| `activeSessionId` | Persisted to localStorage |
| `streamingText` | Accumulated text deltas during a turn |
| `liveToolCalls` | In-flight tool call UI state |
| `pendingApprovals` | User decision gates |
| `pendingQuestions` | `ask_user` cards |
| `sessionAgents` | Selected agent per session |
| `sessionSkills` | Enabled skills per session |
| `sessionTraces` | Observability spans |
| `sessionThinking` | Reasoning text (Copilot only) |
| `terminalOutput` | Shell command history |

### `useProjectStore`

Only `activeProjectId` persisted. Projects list is always fetched fresh from SQLite on app start.

### Hydration Strategy

1. App start: `listSessions(projectId)` returns metadata only (`messages: []`)
2. Session tab click: `activeSessionId` changes → `useSessionHydration` calls `ipc.getSession()` → full message history loaded
3. `mergeSessions()` deliberately preserves existing messages to avoid a hydration race condition
4. Live updates push directly into the store without re-fetching DB

---

## 4. Agent System

### Runner Dispatch

```
runAgentTurn(params)  [electron/agent/runner.ts]
├─ send SESSION_STATUS "running"
├─ getProvider(config.provider)
│  ├─ "anthropic" → claudeProvider.run(params)
│  └─ "copilot"   → copilotProvider.run(params)
└─ On complete: saveMessage() → send SESSION_MESSAGE → send SESSION_STATUS "idle"
```

### Provider Interface

```typescript
interface AgentProvider {
  run(params: AgentProviderParams): Promise<string>;
  listModels?(): Promise<{ id: string; name: string }[]>;
  listAgents?(projectPath: string): Promise<AgentInfo[]>;
  stop?(): Promise<void>;
}
```

### Claude (`electron/agent/claude.ts`)

- Agent discovery: SDK `supportedAgents()` + scan `~/.claude/agents/*.md`
- File-based agents: inject file body as `systemPrompt`
- SDK built-ins: pass `options.agent = agentName` directly
- MCP server: in-process approval-gated tools (`write_file`, `delete_file`, `execute_bash`, `web_fetch`)
- Native tool approval: `PreToolUse` hook intercepts Write/Edit/Bash/WebFetch before execution
- Session continuity: SDK session ID stored in `sessions.sdk_session_id`, resumed on next turn

⚠️ `allowedTools` auto-approves tools without prompting — it does NOT restrict availability. `tools` restricts AND blocks MCP tools. Never swap them.  
⚠️ Enabling `thinking` on Claude SDK disables all `StreamEvent` messages. Do not add `thinking` option.

### Copilot (`electron/agent/copilot.ts`)

- Agent discovery: `.agents/copilot-agents/*.md` (project) + `~/.github-copilot/agents/*.md` (global) + Claude fallback
- System prompt: injected via `systemMessage: { mode: "replace", content: agentBody }`
- Agent change: old SDK session must be discarded (`copilotSessionIds.delete(sessionId)`) — `resumeSession` does not update the system message
- Session IDs: `Map<aichemistSessionId, copilotSDKSessionId>`, singleton `clientInstance`
- Reasoning: supports `assistant.reasoning_delta` streaming (no trade-offs, unlike Claude)

### Agent Selection Flow

1. User opens agent picker → lazy-loads via `ipc.getClaudeAgents()` / `ipc.getCopilotAgents()`
2. Selection → `ipc.updateSessionAgent(sessionId, agentName)` → persisted to `sessions.agent`
3. On `agentSend`, runner reads `agent` from session and activates it
4. `hydrateSession()` restores `sessionAgents[sessionId]` from DB on navigation

---

## 5. Database Layer

**Location:** `~/.aichemist/aichemist.db`

### Schema

```sql
projects (id, name, path UNIQUE, created_at)
  └─ sessions (id, project_id FK, title, status, provider, model, agent, skills JSON,
               sdk_session_id, created_at)
       └─ messages (id, session_id FK, role, content, agent, created_at)
            └─ tool_calls (id, message_id FK, name, args JSON, result JSON,
                           status, category)
```

All FK relationships use cascade delete.

### Migration Strategy

Append-only, idempotent column checks:
```typescript
const hasColumn = (name: string) => columns.some(c => c.name === name);
if (!hasColumn("agent")) db.exec("ALTER TABLE sessions ADD COLUMN agent TEXT;");
```
**Never modify existing SQL.** SQLite does not support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

### Project Config

- Metadata in DB (`projects` table), settings on disk at `<project>/.aichemist/config.json`
- Contains: `provider`, `model`, `approval_rules`, `allowed_tools`
- Version-controllable — users can commit custom approval rules to their repo

---

## 6. Frontend Component Architecture

```
App.tsx
└─ AppShell  (mounts useSessionEvents globally)
   ├─ TitleBar  (38px, webkitAppRegion: drag, hiddenInset traffic lights)
   ├─ ProjectSidebar
   └─ main.flex-1
      └─ WorkspaceView
         ├─ SessionTabBar
         ├─ SplitPane (draggable)
         │  ├─ TimelinePanel  — messages, tool calls, approvals, reasoning
         │  └─ ContextPanel   — Agents | Skills | Changes | Traces | Files tabs
         └─ StatusBar  — model picker, git branch, status dot
```

### Key Components

- **`TimelinePanel`** — Virtualized message list. Renders `LiveToolCall`, `ApprovalCard`, `QuestionCard`, `ReasoningDisplay`
- **`ApprovalCard`** — Scope selector (once / session / project) + approve/deny. Calls `ipc.approveToolCall()`
- **`QuestionCard`** — `ask_user` response UI. Calls `ipc.answerQuestion()`
- **`InteractiveTerminal`** — xterm.js + node-pty. Full PTY lifecycle over IPC (`TERMINAL_CREATE/INPUT/RESIZE/CLOSE/OUTPUT`)
- **`AgentEditorModal` / `SkillEditorModal`** — Shared `readOnly` prop pattern: renders markdown via Streamdown when `true`, textarea when `false`

### Styling Notes

- Tailwind CSS v4 — does **not** scan `node_modules`. Add explicit CSS in `src/index.css` for third-party component styles (e.g. streamdown token colors use `var(--sdm-c)`)
- `DropdownMenu` uses **Base UI** (`@base-ui/react`), not Radix. Use `onClick` on items, not `onSelect`
- `ModelSelectorTrigger` and `DropdownMenuTrigger` do not support `asChild` — style directly with `className`

---

## 7. Strengths

| # | What | Why it matters |
|---|---|---|
| 1 | IPC channel constants (`ipc-channels.ts`) | Single source of truth, refactoring-safe |
| 2 | Provider registry pattern | Swap / add providers without touching runner |
| 3 | Promise-based approval gate | Cleanly pauses/resumes agent execution |
| 4 | Lazy session hydration + `mergeSessions()` | No redundant DB queries, no race-condition data loss |
| 5 | Event-driven streaming | Zero polling, real-time deltas, natural approval interruption |
| 6 | Lean Zustand persistence | Only IDs persisted; DB is source of truth |
| 7 | Strict TypeScript config | Compile-time safety (`noUnusedLocals`, `noUnusedParameters`) |
| 8 | Real PTY terminal (`node-pty`) | True interactive shell, not a fake |
| 9 | Cross-provider agent fallback | Copilot runner can pick up Claude-format agent files |
| 10 | Per-project config on disk | Approval rules are version-controllable |

---

## 8. Issues & Risks

### 🔴 High Priority

#### H1 — Path Traversal in File Tools ✅ Fixed (`b60cc231`)
**File:** `electron/agent/mcp-tools.ts`

`write_file` and `delete_file` resolve paths but don't verify they stay within the project root. A prompt injection or model hallucination could write to `../../.ssh/authorized_keys`.

```typescript
// Current (vulnerable)
const fullPath = path.resolve(projectPath, filePath);
fs.writeFileSync(fullPath, content);

// Fix
const fullPath = path.resolve(projectPath, filePath);
if (!fullPath.startsWith(path.resolve(projectPath) + path.sep)) {
  throw new Error("Path escapes project boundary");
}
```

Also add: max file size limit, blacklist `.git/`, `.env`, `node_modules/`.

---

#### H2 — No Error Handling on IPC Handlers ✅ Fixed (`84f94497`)
**File:** `electron/main.ts`

`ipcMain.handle()` calls have no try/catch. Unhandled rejections silently hang the renderer (spinner forever with no feedback).

Fix: Wrap every handler, emit `SESSION_ERROR` or a toast event back to renderer on failure.

---

#### H3 — Memory Leaks in Promise Maps ✅ Fixed (`3cbb525b`)
**Files:** `electron/agent/copilot.ts`, `electron/agent/approval.ts`, `electron/agent/question.ts`

- `copilotSessionIds` Map grows unbounded — SDK session IDs accumulate for deleted sessions
- `pendingApprovals` / `pendingQuestions` Maps are never cleaned up if the user never responds

Fix: Add TTL eviction (e.g. 5-min idle), and clear entries when a session is deleted.

---

#### H4 — Race Condition on Session Config Reads ✅ Fixed (`237d9d6c`)
If the user changes the agent picker while a turn is running, concurrent SQLite reads produce inconsistent config state (provider, model, agent can be partially updated).

Fix: Read session config once at turn start, hold in memory for the full turn duration.

---

### 🟡 Medium Priority

#### M1 — Silent Context Loss on Agent Switch (Copilot) ✅ Fixed (`2ca4b193`)
Switching agents mid-session discards the Copilot SDK session (it cannot update `systemMessage` dynamically). No UI warning is shown; conversation history silently resets.

Fix: Show confirmation dialog — "Switching agents will start a new conversation in this session."

---

#### M2 — Live Tool Calls Not Persisted ✅ Fixed (`5cb89123`)
`tool_calls` rows are only inserted after a tool completes. If the app crashes mid-execution, the tool call vanishes from history.

Fix: Insert the row immediately with `status = "pending_approval"`, update as it progresses.

---

#### M3 — Session Status Not Written to DB
`updateSessionStatus()` only updates Zustand, not SQLite. After a restart there is no way to detect or recover in-flight sessions.

Fix: Persist status to DB. On app start, mark any session with `status = "running"` as `"error"`.

---

#### M4 — IPC Tightly Coupled, Hard to Unit Test
Components call `ipc.*` directly. There is no way to inject a mock without running Electron.

Fix: Extract `IpcClient` interface, expose via React context, allow tests to provide mock.

```typescript
interface IpcClient { agentSend(...): Promise<void>; /* ... */ }
const IpcContext = React.createContext<IpcClient>(ipc);
export function useIpc() { return useContext(IpcContext); }
```

---

### 🟢 Lower Priority

#### L1 — No Directory Listing Pagination
`readdirSync` on a large project (monorepo, etc.) loads everything into memory and blocks the renderer.

Fix: `listDirectory(path, offset, limit)` + `.gitignore` filtering (skip `node_modules`, `.git`).

---

#### L2 — Session Hydration Blocks Render
Switching to a session with many messages causes jank while the DB query runs.

Fix: `useTransition()` + loading skeleton + paginated load-more (first 50 messages, scroll to load more).

---

#### L3 — No API Key Validation at Startup
An invalid key only surfaces during a turn, mid-conversation. 

Fix: Startup ping to the provider API. Emit warning to renderer if validation fails. Add "Test API Key" button in Settings.

---

#### L4 — `ProjectConfig` Not Schema-Validated
Approval rules JSON is parsed without Zod validation. Corrupt or missing fields silently fall through to defaults, potentially bypassing security policies.

Fix: Add Zod schema for `ProjectConfig`; validate on every load.

---

## 9. Recommendations Summary

| Priority | Change | Commit |
|---|---|---|
| ✅ H1 | Path boundary check on all file tools | `b60cc231` |
| ✅ H2 | `try/catch` + error events on all IPC handlers | `84f94497` |
| ✅ H3 | TTL eviction for session/approval/question maps | `3cbb525b` |
| ✅ H4 | Read session config once per turn, hold in memory | `237d9d6c` |
| ✅ M1 | UI warning on agent switch (context loss) | `2ca4b193` |
| ✅ M2 | Persist tool calls immediately to DB | `5cb89123` |
| 🟡 M3 | Write session status to DB, recover on startup | — |
| 🟡 M4 | `IpcClient` interface for testability | — |
| 🟢 L1 | Directory listing pagination + gitignore filter | — |
| 🟢 L2 | Session hydration pagination + skeleton | — |
| 🟢 L3 | API key validation at startup | — |
| 🟢 L4 | Zod validation for `ProjectConfig` | — |

---

## 10. Key Gotchas Reference

These are documented in `CLAUDE.md` but worth repeating:

| Gotcha | Detail |
|---|---|
| `allowedTools` vs `tools` (Claude SDK) | `allowedTools` auto-approves; `tools` restricts AND blocks MCP tools. Never swap them. |
| Claude extended thinking | Enabling `thinking` disables all `StreamEvent` messages. Do not add a `thinking` option. |
| `DropdownMenuTrigger` / `ModelSelectorTrigger` | Do not support `asChild`. Style directly with `className`. |
| `useChat` from `@ai-sdk/react` | Requires HTTP endpoint. Does not work in Electron. Use Zustand + push events instead. |
| Tailwind v4 + `node_modules` | Third-party component classes won't be generated. Use explicit CSS in `src/index.css`. |
| Base UI `DropdownMenu` | Fires `onClick` not `onSelect`. Use `onClick` on `DropdownMenuItem`. |
| Copilot `systemMessage` | `resumeSession` does not update the system message. Must create new session when agent changes. |
| Copilot `customAgents` | These are sub-agent delegation configs, NOT a system prompt replacement. |
