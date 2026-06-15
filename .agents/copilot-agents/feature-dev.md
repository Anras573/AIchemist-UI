---
name: feature-dev
description: AIchemist-UI feature development agent. Injects project conventions and runs a pre-submission checklist to reduce review loops.
---

You are developing features for AIchemist-UI, an Electron + React + TypeScript desktop application. Full architecture reference is in `CLAUDE.md`. The condensed conventions are in `.github/copilot-instructions.md`.

## Before you write code

1. Identify which provider(s) the change affects: `anthropic`, `copilot`, `ollama`.
2. Check whether the change touches IPC — if so, all four locations must be updated (see checklist below).
3. Check whether the change touches the approval/MCP flow — if so, read `electron/agent/approval.ts` and `electron/agent/mcp-bridge.ts` first.

## IPC wiring — all four required

- [ ] `electron/ipc-channels.ts` — channel name constant added
- [ ] `electron/main.ts` — `ipcMain.handle(CH.YOUR_CHANNEL, handler)` registered
- [ ] `electron/preload.ts` — method exposed via `contextBridge`
- [ ] `src/lib/ipc.ts` — typed wrapper function added

## Pre-submission checklist

Run these before considering the implementation complete:

- [ ] `bun run typecheck` passes — strict mode, unused vars are errors
- [ ] `bun run test` passes
- [ ] Provider gating uses `effectiveProvider` (`session.provider ?? project.config.provider`), not `session.provider` alone
- [ ] New local state has a `useEffect` cleanup keyed on `sessionId` or `projectId`
- [ ] Sessions remain provider-locked — no mid-session provider switching
- [ ] No `useChat` from `@ai-sdk/react` (does not work in Electron)
- [ ] `DropdownMenuItem` uses `onClick`, not `onSelect`
- [ ] No `thinking` option added to the Claude `query()` call (breaks streaming)
- [ ] `allowedTools` not changed to `tools` in `electron/agent/claude.ts`
- [ ] Agent name comparisons normalize both sides to `?? ""`, not `?? null`

## Footguns to avoid

### `allowedTools` vs `tools`
`allowedTools` auto-approves tools. `tools` restricts available tools and silently blocks all MCP tool calls. Never change one to the other.

### Copilot agent tracking
Per-provider SDK state lives in `sessions.provider_state` behind `providerSessionStore` (`electron/agent/provider-session-store.ts`). When comparing the stored agent / MCP fingerprint against the current turn, normalize both sides:
```typescript
const prior = providerSessionStore.get(db, sessionId, "copilot") ?? {};
const normalizedAgent = agent ?? "";
const normalizedMcpFp = mcpFp ?? "";
if ((prior.agent ?? "") !== normalizedAgent || (prior.mcpFp ?? "") !== normalizedMcpFp) {
  /* force fresh session */
}
```
Using `?? null` on the stored side causes `undefined !== ""` to be always true, resetting the Copilot session and destroying conversation history on every turn.

### Copilot `customAgents` vs `systemMessage`
`customAgents` are sub-agent delegation configs — not a system prompt replacement. Use `systemMessage: { mode: "replace", content: agentBody }` to apply a user-selected agent's instructions. Discard the cached SDK session when the agent changes between turns.

### Tool call placeholder message
Create a placeholder assistant message **before** `provider.run()` so tool calls have a valid FK immediately. Delete the placeholder if no content was produced.

### `LIST_DIRECTORY` truncation
Always check the `truncated` flag — results are capped at 500 entries after filtering ignored directories.
