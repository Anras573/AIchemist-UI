# Reasoning Display

Date: 2026-03-31

## Problem

Claude's extended thinking tokens are silently dropped by the runner — users have no
visibility into what the model is reasoning about. The `Reasoning` component from
AI Elements is already installed and purpose-built for this, but requires backend
plumbing to surface the thinking stream.

## Approach

Three-layer change: (1) enable extended thinking in the Claude runner and emit thinking
deltas via a new IPC channel, (2) accumulate them in Zustand, (3) render the
`Reasoning` component in the timeline — auto-open while streaming, auto-collapse when
done.

## Design

### IPC Channels (new)

| Channel | Payload | When emitted |
|---|---|---|
| `SESSION_THINKING_DELTA` | `{ session_id, text_delta }` | Each thinking token chunk |
| `SESSION_THINKING_DONE` | `{ session_id }` | Thinking block closes (triggers collapse) |

### Backend — `electron/agent/claude.ts`

- Detect thinking-capable models by checking whether the model ID contains `"claude-3-7"`
  or later (e.g. `"claude-opus-4"`). Add to a `THINKING_CAPABLE_MODELS` constant.
- For those models, add `thinking: { type: "enabled", budget_tokens: 8000 }` to the
  API options.
- In the stream event loop, alongside the existing `text_delta` handler, add a branch
  for `thinking_delta` blocks: accumulate locally and emit `SESSION_THINKING_DELTA`.
- On `content_block_stop` for a thinking block, emit `SESSION_THINKING_DONE`.
- New channels added to `electron/ipc-channels.ts`, wired through `preload.ts` and
  subscribed in `src/lib/ipc.ts` (`IPC_CHANNELS`).

### Store — `useSessionStore`

New fields:
```ts
sessionThinking: Record<string, string>        // accumulated text per session
sessionIsThinking: Record<string, boolean>     // whether block is actively streaming
```

New actions:
- `appendThinking(sessionId, delta)` — appends delta to `sessionThinking[sessionId]`
- `doneThinking(sessionId)` — sets `sessionIsThinking[sessionId] = false`
- Clear both fields for a session when `SESSION_STATUS` fires `"running"` (new turn)

### Frontend — `TimelinePanel.tsx`

Render above the streaming bubble, only when `sessionThinking[sessionId]` is non-empty:

```tsx
{thinkingText && (
  <Reasoning isStreaming={isThinking}>
    <ReasoningTrigger />
    <ReasoningContent>{thinkingText}</ReasoningContent>
  </Reasoning>
)}
```

- `isStreaming=true` → auto-open (while thinking block is active)
- `isStreaming=false` → auto-collapse (after `SESSION_THINKING_DONE`)
- Cleared on next turn start (via `SESSION_STATUS: "running"`)

## Error Handling

- If the model does not support extended thinking, the API returns an error. Detect
  this at runtime and fall back gracefully (disable thinking for that model/session,
  log a warning, continue without thinking display).
- Thinking content is never saved to SQLite — it is ephemeral to the streaming turn.
  If the app restarts mid-stream, thinking content is simply gone (acceptable).

## Testing

- Unit test `appendThinking` / `doneThinking` store actions
- Render test for `TimelinePanel` with `sessionThinking` populated: assert `Reasoning`
  component appears; assert it is absent when `sessionThinking` is empty

## Out of Scope

- Making `budget_tokens` user-configurable (project config option — future)
- Copilot provider support (SDK does not expose thinking tokens)
- Persisting thinking history in SQLite
- Per-message historical thinking (only current streaming turn is shown)
