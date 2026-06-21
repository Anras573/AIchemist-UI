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
- **Typed contract:** `electron/ipc-contract.ts` defines `IpcContract` — a map from each request/response channel constant to `{ args: [...wire args]; result }`. It is the single source of truth: `handle()` (main) and the preload `invoke()` helper are both generic over it, and `ElectronAPI` result types derive from it via `Res<typeof CH.X>`. A handler or preload line whose args/result are *incompatible* with the channel's declared shape is a compile error. (TypeScript still allows a handler to widen a parameter — e.g. `Provider` → `string` — and stay assignable, so keep handler signatures exact to the contract for full drift protection.)
- **Adding a new IPC handler:** add the channel constant to `ipc-channels.ts`, add an `IpcContract` entry in `ipc-contract.ts`, add the handler to the relevant `electron/ipc/*-handlers.ts` module (the typed `handle()` checks its args/result against the contract), call the register function from `registerAllHandlers()` in `electron/main.ts` if you created a new module, add the `ElectronAPI` method + `invoke(CH.X, …)` line in `electron/preload.ts`, and add the wrapper to `src/lib/ipc.ts`. The compiler enforces that the preload line and handler match the contract.
- **Structured errors:** every `handle()` resolves to an `IpcEnvelope` — `{ ok: true, data }` or `{ ok: false, error: { code, message } }` (`electron/ipc/errors.ts`). The preload `invoke()` unwraps it: resolves with `data`, or throws an `IpcError` carrying a machine-readable `code` (`not_found` / `conflict` / `unauthorized` / `timeout` / `unavailable` / `invalid_input` / `internal`). `classifyError()` derives the code from a thrown error (explicit `IpcError` wins; otherwise heuristics over the message). Renderer code can `import { IpcError } from "@/lib/ipc"` and branch on `err.code`.
- **Input validation:** mutation channels (agent send, message save, file writes) get a zod schema in `electron/ipc/validators.ts`, keyed by channel; `handle()` runs it before the handler and rejects with `invalid_input` on failure. Add an entry there when introducing a new high-impact mutation channel.

### Electron main process modules (`electron/`)

| Module | Role |
|---|---|
| `main.ts` | App entry, creates `BrowserWindow`, calls `registerAllHandlers()` |
| `ipc/` | Domain-specific IPC handler modules (`*-handlers.ts`) — add new handlers here |
| `ipc/handle.ts` | Shared error-wrapping `handle()` wrapper around `ipcMain.handle()` |
| `preload.ts` | `contextBridge` — exposes typed `window.electronAPI` to the renderer |
| `ipc-channels.ts` | Shared IPC channel name constants |
| `config.ts` | Loads `~/.aichemist/.env` via `dotenv`; resolves API keys |
| `db.ts` | Opens `~/.aichemist/aichemist.db` via `better-sqlite3`; numbered migrations gated by `PRAGMA user_version` |
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
| `provider_state TEXT` | **Unified per-provider SDK session state (JSON).** One blob per session, one key per provider (`claude.sdkSessionId`, `copilot.{sessionId,agent,mcpFp}`). Owned by `electron/agent/provider-session-store.ts`. A new provider adds a key here — no schema change. |
| `disabled_mcp_servers TEXT` | JSON array of AIchemist-managed MCP server names disabled for this session. Filtered out by `loadManagedMcpServers({ excludeNames })` before injection. |
| `sdk_session_id TEXT` | **Legacy / dead write.** Superseded by `provider_state.claude.sdkSessionId`. Never written anymore, but read as a one-time fallback for pre-migration sessions (in `claudeProvider.run` and trace lookups); the runner backfills it into `provider_state` and NULLs this column so the fallback can't later resurrect a stale id. |
| `copilot_session_id` / `copilot_session_agent` / `copilot_session_mcp_fp TEXT` | **Legacy / dead write.** Superseded by `provider_state.copilot`. Never written anymore, but read as a one-time fallback for pre-migration sessions (in `runCopilotAgentTurn` and trace lookups); the runner backfills them into `provider_state` and NULLs these columns so the fallback can't later resurrect stale state. |

### Migrations — numbered, gated by `PRAGMA user_version`

`electron/db.ts` runs an ordered `MIGRATIONS` array gated by `PRAGMA user_version`: index `i` is schema version `i + 1` and runs exactly once, inside a transaction with the version bump (so a crash can't half-apply one). The array is **append-only** — never reorder, delete, or edit an existing entry; add new ones to the end (a plain `ALTER TABLE … ADD COLUMN`). v1 is the baseline (columns the old "hasColumn + ALTER on every open" loop used to add, now guarded by `addColumnIfMissing` so existing DBs at `user_version 0` upgrade cleanly).

### Provider session state — `ProviderSessionStore`

`electron/agent/provider-session-store.ts` exposes the app-wide singleton `providerSessionStore`: a read-through cache over `provider_state` where the **DB is the source of truth** and the in-memory map is a per-app-run fast path. API: `get(db, sessionId, provider)`, `set(db, sessionId, provider, state | null)` (write-through; `null` removes the slice and collapses an empty blob to `NULL`), `forget(sessionId)` (drop one cache entry, used on session delete), `reset()` / `_resetProviderSessionStore()` (test seam — clears the whole cache, DB untouched). Both Claude and Copilot read/write their slice through it; there is no longer a "seeded from DB" gate or an in-memory/DB normalization footgun.

### Session provider lock

Each session is locked to a single provider (`"anthropic"`, `"copilot"`, `"ollama"`, or `"openai-compatible"`) at creation. Switching providers mid-session loses context because each provider has its own session id and cannot resume the other's state. The canonical provider list is `PROVIDER_IDS` in `electron/providers.ts` (renderer display metadata in `src/lib/providers.ts`) — the provider pickers, probes fallback, and settings dropdowns all iterate it, so a new provider needs no per-component list edits.

- **Creation:** `SessionTabBar` shows a split button — the main `+` creates with the project default, and the chevron opens a menu to explicitly pick a provider. The renderer calls `ipc.createSession(projectId, providerOverride?)`.
- **Empty state:** When a project has no sessions, `TimelinePanel` renders `EmptyStateNewSession` with per-provider radio buttons plus a primary "Create a new session" button.
- **In-session:** `ModelPickerButton` filters its groups to the session's provider.
- **Runtime:** `AGENT_SEND` resolves `session.provider ?? project.config.provider` before dispatching to the matching runner in `electron/agent/runner.ts`.

### Ollama provider

`electron/agent/ollama.ts` implements a native provider against a locally running Ollama instance (via the `ollama` npm client).

- **No SDK session state:** every turn replays the full message history from SQLite (`loadHistory`) — there is no resume id to persist.
- **Turn loop:** streaming `chat()` with an in-process tool-calling loop capped at `readMaxToolRounds()` rounds (`AICHEMIST_MAX_TOOL_ROUNDS` setting, default 8 — see "Configurable tool-round cap" below). Tools are implemented locally (`tool-impls.ts`: write_file, delete_file, execute_bash, web_fetch, plus read/list/ask_user) and approval-gated through the same `requiresApproval()` / `requestApproval()` path as the other providers. Managed MCP servers are reachable through `createManagedMcpBridge()`. When the cap is hit the turn returns its partial text plus a truncation notice (`emitToolRoundLimitNotice`) instead of throwing.
- **Model resolution:** never hardcode a model name — `resolveModel()` falls back to the first installed model from `listModels()`, and `OLLAMA_NO_MODELS_ERROR` is surfaced when none are installed. A selected agent's `model:` frontmatter overrides the session model for the turn (`resolveModelForTurn()`), matched against installed models via `resolveInstalledModel()` (untagged `codellama` → `codellama:latest`); an unknown agent model warns and falls back rather than failing the turn.
- **`delegate_task` tool:** lets the model delegate a self-contained sub-task to another installed Ollama model (fresh context, depth-limited; `ask_user` and MCP tools are unavailable in delegated turns). Shared constants/errors (`MAX_DELEGATION_DEPTH`, `SUB_AGENT_MAX_ROUNDS`, `SUB_AGENT_SYSTEM_PROMPT`, `delegationDepthLimitError`, `askUserUnavailableError`) live in `electron/agent/delegation.ts` and are reused by the OpenAI-compatible provider.
- **Skills & agents:** supported since Ollama became a first-class provider (PR #31) — `buildSystemPrompt()` appends the selected agent's file body (`readAgentFileSystemPrompt`) and the active skills context (`buildSkillsContext`) to the base system prompt. `AGENT_SEND` passes `skills`/`agent` through unchanged, and `AgentPickerButton` loads agents for Ollama sessions like the other providers.
- **Extended thinking / reasoning:** gated on model capability — `modelSupportsThinking()` reads `ollama.show()`'s `capabilities` and only then passes `think: true` to `chat()`, because requesting thinking from a non-reasoning model errors. A successful probe (or an absent `show`) is cached per model id (cleared by `_resetOllamaClientForTests`); a *transient* probe failure returns `false` without caching so a later turn retries instead of permanently disabling thinking. In the stream, `message.thinking` deltas map to `emitter.thinkingDelta()` (+ `recorder.reasoning()`); there is no explicit end marker, so the reasoning block is closed (`thinkingDone()`) when the first `content`/`tool_call` arrives or at end of stream. The probe is fail-safe (any error → no thinking, never breaks the turn), skipped for `noTools` turns, and `think` is never requested for delegated sub-agents (their output is internal). This lights up the same `Reasoning` component the other providers use.

### OpenAI-compatible provider

`electron/agent/openai-compat.ts` runs turns against user-configured OpenAI-compatible endpoints (LM Studio, vLLM, llama.cpp, Together, …) via `@ai-sdk/openai-compatible` + the AI SDK's `streamText`.

- **Endpoint registry:** `~/.aichemist/openai-providers.json` (`electron/openai-endpoints.ts`), shape `{ "endpoints": { "<name>": { baseURL, apiKey?, headers?, queryParams? } } }`. Written with mode 0600 (may contain keys). Endpoint names must not contain `/`. CRUD via `OPENAI_ENDPOINTS_READ` / `OPENAI_ENDPOINT_UPSERT` / `OPENAI_ENDPOINT_DELETE` (handlers in `settings-handlers.ts`, editor UI in **Settings → Providers**).
- **Composite model ids:** `sessions.model` stores `<endpoint>/<modelId>`, split on the FIRST `/` (`parseCompositeModelId`) so model ids containing slashes survive (`together/meta-llama/Llama-3-70b`). A bare model id is accepted only when exactly one endpoint is configured. One provider id covers any number of endpoints — don't add per-endpoint provider ids.
- **Per-agent model override:** a selected agent's `model:` frontmatter overrides the session model for the turn (`resolveTargetForTurn()` → `resolveOverrideTarget()`). To avoid a per-turn `/models` call, a composite `<endpoint>/<model>` override (referencing a configured endpoint) or a bare id with a single configured endpoint resolves directly — only a bare id with multiple endpoints lists models (`pickAgentModelTarget()`) to discover which one serves it. An unresolvable override falls back to the session model rather than failing the turn — `pickAgentModelTarget()` returns `matched` / `ambiguous` (a bare id served by multiple endpoints → warn to use the composite form) / `none`; it warns only when the model list was fetched but didn't resolve to exactly one endpoint, never when nothing could be listed.
- **No SDK session state:** like Ollama, every turn replays the full history from SQLite into `ModelMessage[]`. `withCurrentPrompt()` ensures the turn's prompt is the final user message (it may differ from the saved row — GitHub-issue augmentation — or be missing entirely for `skipPersistence` turns).
- **Turn loop:** one `streamText({ tools, stopWhen: stepCountIs(readMaxToolRounds()) })` call (`AICHEMIST_MAX_TOOL_ROUNDS`, default 8); the AI SDK drives the multi-step tool loop. Built-in tools are zod-schema `tool()`s whose `execute` goes through `runGatedTool` (same approval gate + tool_call persistence as Ollama); managed MCP tools are wrapped with `dynamicTool` + `jsonSchema()`. `fullStream` parts map to the emitter: `text-delta` → `delta`, `reasoning-delta`/`reasoning-end` → thinking events, `finish.totalUsage` → `usage`, `error` → turn failure. A final `finish.finishReason === "tool-calls"` means the step cap halted the loop mid-workflow, so a truncation notice (`emitToolRoundLimitNotice`) is appended to the turn text.
- **`delegate_task` tool:** like Ollama, lets the model delegate a self-contained sub-task to another model (a configured endpoint's model — composite `<endpoint>/<model>` or a bare id resolved via `resolveDelegateTarget`). The sub-turn runs a nested `streamText` with the shared `SUB_AGENT_SYSTEM_PROMPT`, a tighter `SUB_AGENT_MAX_ROUNDS` cap, a delta-suppressed emitter (`emitter.withoutDeltas()`), and fresh context (no history). Guardrails are depth-limited to `MAX_DELEGATION_DEPTH` (1) and `ask_user` is blocked in delegated turns; MCP tools are not offered to sub-agents. The shared constants/errors live in `electron/agent/delegation.ts` (reused by Ollama).
- **Model listing & probe:** `GET {baseURL}/models` per endpoint (5 s timeout, best-effort across endpoints — one dead endpoint doesn't hide the rest). The provider implements `AgentProvider.probe()` itself (30 s cache, `_resetOpenAiCompatProbeCache()` invalidated on endpoint CRUD), so `provider-probe.ts` needed no changes.
- **Test seams:** `_setFetch`, `_setClientFactory` (inject a `MockLanguageModelV3` from `ai/test` so the real `streamText` loop runs in tests), `_setEndpointsPathForTests`, `_resetOpenAiCompatProbeCache`. Tests in `electron/agent/openai-compat.test.ts` and `electron/openai-endpoints.test.ts`.

### Configurable tool-round cap (self-driven providers)

The Ollama and OpenAI-compatible providers run their tool loop in-process and so need an explicit cap (the SDK-backed Claude / Copilot providers are bounded by the context window instead). The cap is the `AICHEMIST_MAX_TOOL_ROUNDS` app setting (`electron/settings.ts`), surfaced in **Settings → Defaults**.

- `parseMaxToolRounds()` parses + clamps to `[MIN_MAX_TOOL_ROUNDS, MAX_MAX_TOOL_ROUNDS]` = `[1, 100]`, defaulting to `DEFAULT_MAX_TOOL_ROUNDS = 8` for empty / invalid input. `readMaxToolRounds()` reads it from settings; both providers call it once per turn (so a saved change takes effect on the next turn, no restart).
- When the cap is hit, the turn does **not** throw — it returns its partial text with a user-visible truncation notice from `emitToolRoundLimitNotice()` (`electron/agent/turn-emitter.ts`), which both streams the notice as a `delta` and returns the text to append to the persisted message. Ollama detects this when the loop exhausts its rounds; OpenAI-compatible detects it via the final `finish.finishReason === "tool-calls"`.
- The renderer mirrors the `[1, 100]` bounds as plain numbers in `SettingsView.tsx` (it can only type-import from `electron/settings`, never value-import the Node-only module).

---

## Traces (transcript-based)

The Traces tab does **not** use an in-memory tracer. Instead, every provider has a structured session transcript on disk, and we parse it on demand (non-blocking reads) into `TraceSpan[]`. The SDK-backed providers (Claude, Copilot) get theirs from the SDK; the self-driven providers (Ollama, OpenAI-compatible) write their own (see below).

| Provider | Transcript path | Parser |
|---|---|---|
| Claude | `~/.claude/projects/<encoded-cwd>/<sdk_session_id>.jsonl` | `electron/claude-transcript.ts` |
| Copilot | `~/.copilot/session-state/<copilot_session_id>/events.jsonl` | `electron/copilot-transcript.ts` |
| Ollama / OpenAI-compatible | `~/.aichemist/traces/<sessionId>/events.jsonl` | `electron/native-transcript.ts` |

### Native-provider transcripts — `electron/native-transcript.ts`

Ollama and OpenAI-compatible run an in-process tool loop and have no SDK session id, so they write their own JSONL transcript keyed by **app `sessionId`** (not an SDK id). Each turn a `NativeTranscriptRecorder` (`createNativeTranscriptRecorder(sessionId, provider)`) appends events: `turn_start` first (so the live turn span exists), then `tool_call` / `tool_result` as they happen (id-paired into tool spans), then a folded `reasoning` + `usage` summary and `turn_end` at the end. The two providers call `turnStart` / `turnEnd` (in a `finally`, with success/error status) and record reasoning/usage; **tool events are recorded in the shared `runGatedTool`** via an optional `recorder` on `GatedToolContext` (unset for the SDK providers, so they're unaffected). `noTools` turns (text-only PR-draft generation) are not recorded. Writes are fail-safe — a transcript I/O error can never break a turn. Test seam: `_setNativeTracesRootForTests(dir | null)`.

### IPC surface

- **`GET_TRACES({ sessionId })`** in `electron/ipc/trace-handlers.ts` — dispatches by provider: reads the SDK session id from `provider_state` (`claude.sdkSessionId` / `copilot.sessionId`), falling back to the legacy `sessions.sdk_session_id` / `copilot_session_id` columns for pre-migration sessions, then parses the corresponding file. When neither SDK id exists, it resolves the session's **effective provider** (`session.provider ?? project.config.provider`) and, for the self-driven providers (Ollama / OpenAI-compatible), reads the native transcript at `~/.aichemist/traces/<sessionId>/events.jsonl`. Resolving by provider rather than file existence lets the watcher bind before the first turn has written the file.
- **`TRACE_BIND_TRANSCRIPT({ sessionId })`** — sets up an `fs.watch` watcher (directory-level, with a 1 s stat-poll safety-net for macOS) on the transcript file and streams incremental spans via `SESSION_TRACE`. The `TracesPanel` calls this when the tab opens.

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

Traces only appear once the session has run at least one turn — that's when the SDK session id (`provider_state.claude.sdkSessionId` / `provider_state.copilot.sessionId`) is first populated. Before then, `GET_TRACES` returns an empty array. Don't add a fallback that synthesizes spans from `tool_calls` rows; the transcript is the source of truth.

---

## Agent Selection

The app has a VS Code-style **agent picker** in the input bar (`src/components/session/AgentPickerButton.tsx`). It replaces the old Agents tab (which is now the **Skills** tab, showing only skills/tools from `.agents/skills/`).

### How it works

1. User clicks the agent picker button next to the message input.
2. The dropdown loads available agents (lazy, cached after first fetch) via `ipc.getClaudeAgents()` or `ipc.getCopilotAgents()` depending on the active provider.
3. Selecting an agent calls `ipc.updateSessionAgent(sessionId, agentName)` — persisted to `sessions.agent` in SQLite.
4. On the next `agentSend`, the runner picks up the agent and activates it:
   - **Claude:** `options.agent = agentName` passed to Claude Code SDK (for SDK built-ins) or the agent file body injected as `systemPrompt`
   - **Copilot:** agent file body injected as `systemMessage: { mode: "replace" }` in the session config. If the agent changed since the last turn, the old SDK session is discarded so the new system message takes effect from turn 1. Lookup order: Copilot agent files → Claude agent files (cross-provider fallback for agents selected via Command Palette), resolved together with the agent's `model:` override by `resolveSelectedAgent()`.

   **Per-agent `model:` frontmatter** is honored across all providers — Claude (`claude.ts`), Copilot (`sessionConfig.model`), Ollama, and OpenAI-compatible all override the session model for the turn when the selected agent file declares one (see each provider's section for validation/fallback details).
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

`scanSkillsDir()` in `electron/skills-discovery.ts` reads skill descriptions from `SKILL.md` frontmatter first (falls back to `README.md`). `scanPluginSkills()` reads `~/.claude/plugins/installed_plugins.json`, picks the most-recently-updated install per plugin, and walks `<installPath>/skills/*/SKILL.md`. `scanCopilotPluginSkills()` walks `~/.copilot/installed-plugins/<scope>/<plugin>/skills/*/SKILL.md` directly (no manifest file).

`LIST_SKILLS` accepts `{ projectPath, provider }` (or a bare `projectPath` string for back-compat — treated as Claude). The handler branches on `provider` to choose between the Claude and Copilot global/plugin scanners. The renderer (`SkillsPanel`) passes `useActiveSessionProvider()` so the listing always matches the active session's provider lock.

`buildSkillsContext()` in `electron/agent/skills.ts` resolves SKILL.md content for active skills. It searches **all** known locations in priority order (project → Claude global → Copilot global → Claude plugins → Copilot plugins) so a toggled skill is injectable regardless of which provider runs the turn. Two module-level lazy caches (`pluginSkillPathCache`, `copilotPluginSkillPathCache`) map skill name → dir path; call `_resetPluginSkillCache()` in tests to reset both.

### Slash command palette

Typing `/` in the message input opens a floating popover listing skills and built-in actions. Selecting a skill adds a one-shot badge (applied to that message only, not persisted to the session). Built-in actions: `/new`, `/clear`, `/help`, `/agent`. See `src/components/session/SlashCommandPopover.tsx` and `InputBarInner` in `src/components/session/InputBar.tsx`.

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

The right-side context panels (Skills, MCP, Memory) filter their content to the active session's provider, matching the per-session provider lock. Use `useActiveSessionProvider()` from `src/lib/hooks/useActiveSessionProvider.ts` — it resolves the session's `provider` and falls back to the active project's default for legacy sessions, returning a `Provider` (`"anthropic" | "copilot" | "ollama" | "openai-compatible"`) or `null`.

- **MCP** (`McpServersPanel`) filters its rows by `source`: Claude sessions see `claude`/`both`, Copilot sees `copilot`/`both`. AIchemist-managed servers (`source: "aichemist"`) are passed through to **both** providers.
- **Memory** (`MemoryPanel`) is provider-aware: it passes the provider into `LIST_MEMORY`, which resolves the store per provider — Claude reads the SDK-owned `~/.claude/projects/<cwd>/memory`, while every other provider (Ollama, OpenAI-compatible, Copilot) reads `memoryDir(projectPath)` (`~/.aichemist/memory/<cwd>`, owned by `electron/agent/memory.ts`) — one shared store so memory is portable across providers for a project. Copilot injects the same `buildMemoryContext()` block into its `systemMessage` (via `composeCopilotSystemMessage`) and registers `write_memory`/`read_memory`/`delete_memory` as `defineTool`s; memory is deliberately kept OUT of the resume-invalidation fingerprint (a memory write must not churn the SDK session — `resumeSession` ignores an updated systemMessage anyway, and `read_memory` recalls notes on demand).
- **Skills** (`SkillsPanel`) passes the provider through to `LIST_SKILLS` so the backend scans the right global / plugin paths (see Skills Panel section).

---

## Provider availability probes

`electron/agent/provider-probe.ts` ships lightweight liveness checks per provider so the new-session UI can grey out providers that aren't usable on this machine (missing key, Ollama not running, etc.) before the user picks them.

| Provider | Probe |
|---|---|
| **anthropic** | `POST ${ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages` with `max_tokens: 1` and `anthropic-version: 2023-06-01`, 5 s timeout. This is the endpoint the SDK actually uses, so the probe also works behind enterprise proxies that only forward `/v1/messages`. Auth: tries `x-api-key` (`ANTHROPIC_API_KEY`) first; on 401 falls back to `Authorization: Bearer ${ANTHROPIC_AUTH_TOKEN}` if set. If no env vars are set but `~/.claude/.credentials.json` exists (Pro/Max OAuth login), reports ok. Status mapping: `400/406/429` = ok (auth processed); `401/403` = "invalid key"; `404` = "check ANTHROPIC_BASE_URL"; `5xx` = HTTP status; network error = error message. |
| **copilot** | `GITHUB_TOKEN` set → wraps `copilotProvider.listModels()` with a 5 s timeout. Empty array or throw = not ok. |
| **ollama** | Wraps `ollamaProvider.listModels()` with a 5 s timeout. Empty array or throw = not ok. |
| **openai-compatible** | Provider-owned `probe()` on `openaiCompatProvider` (not in `provider-probe.ts`): no endpoints configured = not ok with guidance; otherwise `GET /models` across endpoints, ok when ≥1 model is reachable. Own 30 s cache, reset on endpoint CRUD. |

**Caching** mirrors `mcp-probe.ts`: 30 s in-memory, keyed by provider id. `force: true` bypasses. The hook re-probes on Electron `BrowserWindow.focus`; the cache absorbs spurious focus events. Providers can instead implement `AgentProvider.probe()` (takes precedence; caching is then the provider's responsibility).

**Test seams:** `_setFetch`, `_setCopilotListModels`, `_setOllamaListModels`, `_resetProviderProbeCache`. Tests in `electron/agent/provider-probe.test.ts`.

**IPC:** `PROBE_PROVIDERS` channel, handler in `electron/ipc/settings-handlers.ts`, exposed as `ipc.probeProviders({ projectId?, force? })`. Renderer hook `useProviderProbes(projectId?)` fetches on mount + on window focus and exposes `{ probes, checking, refresh }`.

**User-disabled providers:** the `AICHEMIST_DISABLED_PROVIDERS` setting (comma-separated list of `PROVIDER_IDS` values, edited in **Settings → Providers**) lets the user hide providers app-wide. The IPC handler reads it via `parseDisabledProviders(...)` and passes a `Set` to `probeAll(..., { disabled })`, which short-circuits the underlying probe and returns `{ ok: false, reason: "Disabled in settings" }`. All three gating UI surfaces pick it up automatically. Existing sessions keep working — sessions are provider-locked at creation, so disabling a provider only hides it from the new-session pickers.

**UX surfaces:**
- `SessionTabBar` chevron menu — disabled items show `(unavailable)` and a `title` tooltip with the reason.
- `EmptyStateNewSession` — radios for unavailable providers are disabled; initial selection skips disabled providers; "Create" button disabled when the selection isn't available.
- `ProjectSettingsSheet` Provider dropdown — unavailable options annotated `— unavailable`, disabled (unless currently selected so the user can keep editing), with an inline `<AlertCircle>` reason underneath.

`ModelPickerButton` is intentionally NOT gated — sessions are provider-locked at creation, so disabling models post-hoc would just orphan the user.

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
| Copilot invalidation | `client.resumeSession()` does NOT honour an updated `mcpServers`. A stable fingerprint is stored in `provider_state.copilot.mcpFp` (via `providerSessionStore`); on each turn, an agent change OR fingerprint change forces a fresh `createSession`. |
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

To make a user-selected agent's instructions the primary context, use `systemMessage: { mode: "replace", content: agentBody }` in the `createSession`/`resumeSession` config. When the agent changes between turns, the cached Copilot SDK session must be discarded so the next turn creates a fresh session with the new system message — `resumeSession` does not update the system message of an existing session. With `providerSessionStore`, this is just: skip the resume (`resumeId = null`) when `prior.agent` differs from the current agent, then `set(db, sessionId, "copilot", { sessionId, agent, mcpFp })` after creating the fresh session.

### Copilot SDK — Agent / MCP-fingerprint change detection

`copilot.ts` reads the prior Copilot SDK state for a session via `providerSessionStore.get(db, sessionId, "copilot")` — a single DB-backed blob (`{ sessionId, agent, mcpFp }`). Both sides of every comparison come from that same blob, so the old in-memory-map-vs-DB-column normalization footgun is gone. Still normalize `undefined`/`null` to `""` when comparing, since a stored slice may carry `null`:

```typescript
const prior = providerSessionStore.get(db, sessionId, "copilot") ?? {};
const normalizedAgent = agent ?? "";
let resumeId = prior.sessionId ?? null;
if (resumeId && ((prior.agent ?? "") !== normalizedAgent || (prior.mcpFp ?? "") !== normalizedMcpFp)) {
  resumeId = null; // stale systemMessage / mcpServers → force a fresh createSession
}
// …create or resume…
providerSessionStore.set(db, sessionId, "copilot", { sessionId: session.sessionId, agent: normalizedAgent || null, mcpFp: normalizedMcpFp || null });
```

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

### Non-interactive (unattended) turns — `nonInteractive`

Scheduled workflow runs (see `docs/plans/2026-06-21-workflow-scheduling-design.md`) execute with nobody watching, so the two interactive pause points must never hang on the 5-minute timeout. A `nonInteractive: boolean` is threaded through the turn params — `QueuedTurn` → `executeAgentTurn` → `runAgentTurn` → `AgentProviderParams` → every provider — and taps into the existing gates. As a safety net, `executeAgentTurn` forces `nonInteractive` true whenever **no window is attached** (`win === null`), since a headless turn has no renderer that could ever answer a prompt; a workflow's own `interactive` autonomy therefore only takes effect while a window is attached (a babysat reuse session or a focused "Run now").

- **`requestApproval(..., { nonInteractive })`** (`approval.ts`) and **`requestQuestion(..., { nonInteractive })`** (`question.ts`) take an immediate-resolve branch when `nonInteractive` is true: approvals deny (`false`), `ask_user` resolves `""` — no renderer emit, no timer. The flag is **additive**; interactive user turns omit it and keep today's behavior.
- The flag reaches the gates two ways: via `GatedToolContext.nonInteractive` (read in `runGatedTool`, so Ollama / OpenAI-compatible / Copilot custom tools + Claude's MCP tools are covered) and via direct `{ nonInteractive }` opts on the per-provider `requestApproval`/`requestQuestion` calls (Claude's `PreToolUse` hook, Copilot's `onPermissionRequest`, and each provider's `ask_user`). An unattended auto-deny surfaces a **distinct** message (`TOOL_DENIED_UNATTENDED_MESSAGE` in `tool-gate.ts`; the Claude hook's block reason) so a workflow transcript reads "denied automatically — not in allowlist" rather than the misleading interactive "Denied by user." The auto-deny / empty-`ask_user` warnings log the `sessionId` for run correlation.
- **Per-workflow autonomy** maps onto this: `interactive` leaves `nonInteractive` falsy (the run still pauses for approval); `autonomous` sets `nonInteractive` and pre-trusts tools through the *existing* `isProjectAllowed` + `approval_mode: "none"` mechanism — trusted tools never reach the gate, un-allowlisted ones deny immediately rather than prompting. No new approval mechanism was added.

### Workflows — scheduler + manual run

Workflows are saved, repeatable agent tasks (see `docs/plans/2026-06-21-workflow-scheduling-design.md`). CRUD lives in `electron/workflows.ts` (tables `workflows` / `workflow_runs`); the turn-execution core is `electron/agent/workflow-scheduler.ts`.

- **`runWorkflow(ctx, workflowId, trigger, hooks?)`** resolves/creates the target session per `session_strategy` (`fresh` → a new `createSession` per run; `reuse` → lazily create + persist `reuse_session_id`), writes a `workflow_runs` row (`running`), drives the turn through the shared headless entry point, and finalizes the run to `success` / `error` / `skipped` in a `finally`. It awaits the turn, so the caller (the `WORKFLOW_RUN_NOW` handler) gets the terminal run row back. It only *rejects* if the workflow id is unknown; a turn that throws is captured as an `error` run. The optional `hooks.onRunUpdated(run, workflow)` fires (fail-safe) on each state change — `running` then the terminal state.
- **Overlap policy:** the run is dispatched via `runTurnExclusive()` in `agent-turn-queue.ts`, which short-circuits to `{ skipped: true }` when `isSessionBusy()` (a turn running, queued, or paused). A busy (reuse) session records the fire as `skipped` rather than stacking. `fresh` workflows get a brand-new session each run, so they never skip.
- **Autonomy → nonInteractive:** `autonomous` sets `turn.nonInteractive = true`; `interactive` leaves it falsy (but `executeAgentTurn` still forces it true when no window is attached — see the unattended-turns section).
- **`WorkflowScheduler` class** (in `workflow-scheduler.ts`) owns the cron jobs. Constructed in `main.ts` whenReady with `{ db, activeTurns, getMainWindow }` and (optionally) hooks; `start()` arms every enabled workflow with a `cron` after `registerAllHandlers()`, `stopAll()` runs on `before-quit`. `rearm(id)` stops the old job and re-arms from the current DB row (a disabled / cron-cleared row ends up with no job); `cancel(id)` stops a job; `delete(id)` cancels then removes rows; `runNow(id, trigger?)` runs with the scheduler's notify+push hooks. **Forward-only** — `croner` fires from now; missed occurrences while the app was closed are not replayed. A failing run never disarms its job. Default hooks push `WORKFLOW_RUN_UPDATED` to an open renderer and fire an OS `Notification` on terminal states (both fail-safe — a missing window/notification never breaks a run).
- **IPC:** `WORKFLOW_UPSERT` (create when no id / patch when id resolves — re-arms the scheduler), `WORKFLOW_RUN_NOW` (`trigger: "manual"`), `WORKFLOW_DELETE` (cancels the job, cascades runs), `WORKFLOW_LIST_RUNS` (run history), and the `WORKFLOW_RUN_UPDATED` push event. Handlers in `electron/ipc/workflow-handlers.ts` (registered with the scheduler instance). `WORKFLOW_UPSERT` has a zod validator in `validators.ts` whose `cron` field is checked with `isValidCron()` (croner) so an unparseable schedule is rejected at the boundary.
- **Cron** uses **`croner`** (zero-dep, TS-native, DST-aware). `validateCron()` / `isValidCron()` (in `electron/cron.ts`) parse with `{ paused: true }` so validating never arms a timer.

### Session status persistence and crash recovery

`sessions.status` is persisted to SQLite (`idle` / `running` / `error`) via `updateSessionStatus()` called in `runner.ts` at each transition. On `app.whenReady()`, `recoverStaleSessionStatuses()` marks any session stuck in `"running"` as `"error"` — this handles crashes and force-quits where the normal idle/error transition never ran.

If you add a new IPC handler that starts an agent turn, always call `updateSessionStatus(db, sessionId, "running")` at the start and `"idle"` or `"error"` at the end so crash recovery works correctly.

### LIST_DIRECTORY — filtering and cap

The `LIST_DIRECTORY` IPC handler in `electron/ipc/fs-handlers.ts` applies two safeguards before returning entries:

1. **`IGNORED_DIR_NAMES`** — a `Set` of directory names (`node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `.turbo`) that are filtered out before counting or returning.
2. **`MAX_DIR_ENTRIES = 500`** — if more than 500 entries remain after filtering, the list is truncated and `{ entries, truncated: true }` is returned. The caller (agent tool) should surface this to the model so it doesn't assume the listing is complete.

Always check the `truncated` flag in any code that consumes `LIST_DIRECTORY` results.

## Code Review Lessons

> Extracted from PR #23 (which introduced Ollama as a chat-only provider; Ollama has since become first-class — PR #31 added skills/agent support, so the chat-only gating described below no longer exists)

- When adding a provider to `ProjectSettingsSheet`, reset `model` to a provider-appropriate default whenever the provider field changes — never preserve the previous provider's model string in the new provider's config.
- Never hardcode an Ollama model name (e.g. `llama3.2`) — always resolve from `listModels()` at session/config creation time; no Ollama model is guaranteed to be installed.
- When a capability is provider-gated, gate via `effectiveProvider` (`session.provider ?? project.config.provider`), not just `session.provider` — legacy `null`-provider sessions inherit the project provider and must be caught.
- Apply provider gating on both sides of the IPC boundary — the `AGENT_SEND` handler in `electron/ipc/agent-handlers.ts`, not just the renderer hooks.
- Use `null` as the "not yet loaded" sentinel for the `skills` array; `[]` means "empty list" and blocks `ensureSkillsLoaded` from re-fetching after switching back to a supported provider.
- `defaultProjectConfig` and `ProjectConfigSchema.model` must stay in sync — Zod defaults are provider-agnostic, so apply provider-aware defaults post-parse in `parseProjectConfig`.
- When wiring a new provider into global settings (`AICHEMIST_DEFAULT_PROVIDER`), also wire it through to `defaultProjectConfig` and `addProject` in the same commit.
- Local error/loading state (`createError`, model caches, skills cache) must be cleared when its scoping context changes — add a `useEffect` keyed on `projectId`/`activeProjectId`/`sessionId` at the same time the state is introduced.
- New provider runtimes need focused unit tests for the full turn execution path (history, streaming deltas, model fallback, client construction) — probe/availability tests alone are not sufficient.
