# AIchemist-UI — Copilot Instructions

AIchemist-UI is an **Electron desktop application** with a React/TypeScript renderer (`src/`) and a Node.js main process (`electron/`). Full architecture reference is in [`CLAUDE.md`](../CLAUDE.md). This file covers the conventions and footguns most likely to require review feedback.

---

## Commands

```bash
bun run dev        # start dev environment (hot-reload)
bun run typecheck  # type-check both src/ and electron/
bun run test       # run the test suite
bun run build      # production build
```

Package manager is **bun** — never use npm or yarn. TypeScript strict mode is enabled with `noUnusedLocals` and `noUnusedParameters` — unused variables are compile errors.

---

## IPC wiring — all four locations are required

Every new IPC channel must be wired in exactly four places:

1. **`electron/ipc-channels.ts`** — add a channel name constant
2. **`electron/ipc/<domain>-handlers.ts`** — add the handler inside the relevant `register*()` function (e.g. `session-handlers.ts` for session channels, `agent-handlers.ts` for agent channels). If no existing module fits, create a new one and call its register function from `registerAllHandlers()` in `electron/main.ts`.
3. **`electron/preload.ts`** — expose the method via `contextBridge.exposeInMainWorld`
4. **`src/lib/ipc.ts`** — add a typed wrapper function

Always use the constant from `ipc-channels.ts` — never use raw channel strings.

---

## Critical footguns

### `allowedTools` vs `tools` in the Claude Code SDK

These two `Options` fields are not interchangeable:

| Field | Effect |
|---|---|
| `allowedTools: string[]` | Auto-approves the listed tools without a permission prompt. Does **not** restrict availability. |
| `tools: string[]` | Restricts available built-in tools to exactly that list — and also **silently blocks all MCP tool calls**. |

**Never change `allowedTools` to `tools`** in `electron/agent/claude.ts`. Doing so prevents all MCP tool calls (write_file, execute_bash, web_fetch, delete_file) without showing any error to the user.

### `DropdownMenu` uses Base UI, not Radix UI

`src/components/ui/dropdown-menu.tsx` wraps `@base-ui/react/menu`. Base UI's `Menu.Item` fires `onClick`, **not** `onSelect`. Always use `onClick` on `DropdownMenuItem` — `onSelect` silently does nothing.

`DropdownMenuTrigger` and `ModelSelectorTrigger` do **not** support `asChild` — style them directly with `className`.

### Provider session state — `ProviderSessionStore`

Per-provider SDK session state lives in one JSON column, `sessions.provider_state`, behind the `providerSessionStore` singleton (`electron/agent/provider-session-store.ts`) — a read-through cache where the DB is the source of truth. Claude stores `claude.sdkSessionId`; Copilot stores `copilot.{sessionId,agent,mcpFp}`. A new provider adds a key, not a column. Use `get(db, sessionId, provider)` / `set(db, sessionId, provider, state | null)`; `_resetProviderSessionStore()` is the test seam.

When detecting an agent or MCP-fingerprint change in `copilot.ts`, normalize `undefined`/`null` to `""` before comparing (a stored slice may carry `null`):

```typescript
const prior = providerSessionStore.get(db, sessionId, "copilot") ?? {};
const normalizedAgent = agent ?? "";
const normalizedMcpFp = mcpFp ?? "";
let resumeId = prior.sessionId ?? null;
if (resumeId && ((prior.agent ?? "") !== normalizedAgent || (prior.mcpFp ?? "") !== normalizedMcpFp)) {
  resumeId = null; // stale systemMessage/mcpServers → force a fresh createSession
}
```

A type-mismatched comparison would silently destroy conversation history on every turn when no agent is selected.

### Never use `useChat` in AI Elements components

`useChat` from `@ai-sdk/react` requires an HTTP endpoint and **does not work in Electron**. Drive AI Elements components from Zustand state updated by push events from the main process. Do not add `useChat` to any component in this repo.

### Provider gating — always use `effectiveProvider`

When checking which provider a session uses, always resolve `effectiveProvider`:

```typescript
const effectiveProvider = session.provider ?? project.config.provider;
```

Never gate on `session.provider` alone — legacy sessions have `provider: null` and inherit the project's provider.

Apply gating on **both sides** of the IPC boundary: in the renderer hook/component and in the `AGENT_SEND` handler in `electron/ipc/agent-handlers.ts`.

### Streaming vs Extended Thinking (Claude SDK)

Enabling extended thinking (`thinking: { type: "enabled" }` or `maxThinkingTokens`) **disables all `StreamEvent` messages**, making the UI appear frozen until the full response is ready. Do not add a `thinking` option to the `query()` call in `electron/agent/claude.ts`.

### `customAgents` vs `systemMessage` in the Copilot SDK

`customAgents` in Copilot sessions are sub-agent delegation configs — they are not a replacement for the session system prompt. To apply a user-selected agent's instructions, use `systemMessage: { mode: "replace", content: agentBody }` in `createSession`/`resumeSession`. When the agent changes between turns, discard the cached SDK session so the new system message takes effect from turn 1.

---

## Patterns to follow

### Tool call persistence — placeholder message

Tool calls are stored with a `message_id NOT NULL` FK. Create a placeholder assistant message **before** `provider.run()` so tool calls have a valid FK immediately:

```typescript
const placeholder = createPlaceholderMessage(db, { sessionId, agent });
const text = await provider.run({ ...params, messageId: placeholder.id });
const toolCalls = loadToolCallsForMessage(db, placeholder.id);
if (text.trim() || toolCalls.length > 0) {
  updateMessageContent(db, placeholder.id, text);
} else {
  db.prepare("DELETE FROM messages WHERE id = ?").run(placeholder.id);
}
```

### Session state split

- **SQLite** is the source of truth for persisted messages, tool calls, and session metadata.
- **Zustand (`useSessionStore`)** holds ephemeral streaming state, live tool calls, pending approvals, and pending questions.
- Do not manually sync them — the IPC event flow handles it.

### New local state must be cleared on context change

Any local state scoped to a session or project must have a `useEffect` that clears it when the scoping context changes:

```typescript
useEffect(() => {
  setLocalState(null);
}, [sessionId]); // or projectId, activeProjectId, etc.
```

### Provider lock

Sessions are locked to a single provider (`"anthropic"`, `"copilot"`, or `"ollama"`) at creation. Never allow mid-session provider switching — each provider has its own session ID and cannot resume the other's state.

### Session status persistence

If you add an IPC handler that starts an agent turn, always call `updateSessionStatus(db, sessionId, "running")` at the start and `"idle"` or `"error"` at the end. This enables crash recovery — `recoverStaleSessionStatuses()` on startup marks any `"running"` session as `"error"`.

### `LIST_DIRECTORY` — check the `truncated` flag

`LIST_DIRECTORY` filters ignored directories (`node_modules`, `.git`, etc.) and caps results at 500 entries. Always check the `truncated` flag in code that consumes the result.

---

## Styling

Tailwind CSS v4 (via `@tailwindcss/vite` plugin). Use `cn()` from `src/lib/utils.ts` for conditional class merging. Use shadcn/ui components from `src/components/ui/`.

**Tailwind v4 does not scan `node_modules`** — if a third-party component (e.g. `streamdown`) renders Tailwind classes from its dist bundle, those classes will not be generated. Add explicit CSS rules in `src/index.css` instead.

Use `<WithTooltip label="…">` from `src/components/ui/with-tooltip.tsx` for hover hints — do not use native `title=` on the same element.

---

## Path alias and types

- `@/` resolves to `src/` — always use it for non-relative imports within `src/`.
- Types are in `src/types/index.ts`. Field names use **snake_case** — do not rename to camelCase.

---

## Testing xterm.js components

jsdom has no canvas. Mock `@xterm/xterm` and `@xterm/addon-fit` using `vi.fn().mockImplementation(function() { ... })` (arrow functions are not constructors). Also stub `global.ResizeObserver` the same way.
