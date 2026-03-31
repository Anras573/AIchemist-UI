# Interactive Questions — ask_user MCP Tool

Date: 2026-03-31

## Problem

Claude runs as a continuous stream with no native "pause and ask" mechanism. When it
needs clarification or a decision it outputs a question as regular text, the turn ends,
and the user must notice, read it, and type a reply manually. There is no structured
signal that a question was asked, no enforced pause, and no way to offer pre-defined
choices.

## Approach

A custom `ask_user` MCP tool that Claude calls explicitly when it needs input. The
tool handler blocks (like the existing approval gate) and emits a push event to the
renderer. The UI renders a question card; the user's answer is returned to the tool as
its result; the agent resumes. This reuses the existing approval-gate infrastructure
and requires no changes to the SDK or Claude runner.

## Design

### MCP Tool — `ask_user`

Registered in `electron/agent/mcp-tools.ts` alongside the existing approval gate tools.

**Schema:**
```json
{
  "name": "ask_user",
  "description": "Ask the user a question and wait for their answer before proceeding. Use when you need clarification, missing information, or a decision from the user.",
  "parameters": {
    "question":    { "type": "string",            "required": true  },
    "options":     { "type": "array of strings",  "required": false },
    "placeholder": { "type": "string",            "required": false }
  }
}
```

**Handler flow:**
1. Create a `Promise<string>` whose resolve function is stored by `questionId`
2. Emit `SESSION_QUESTION_REQUIRED` to the renderer
3. `await` the Promise (blocks the MCP tool call, agent is paused)
4. On resolution, return `{ answer }` as the tool result
5. Agent receives the answer and continues

### IPC Channels (new)

| Channel | Direction | Payload |
|---|---|---|
| `SESSION_QUESTION_REQUIRED` | main → renderer | `{ session_id, question_id, question, options?, placeholder? }` |
| `SESSION_QUESTION_ANSWER` | renderer → main | `{ session_id, question_id, answer }` |

Wired through `ipc-channels.ts`, `preload.ts`, and `src/lib/ipc.ts` following the
same pattern as the approval gate.

### Store — `useSessionStore`

New fields (parallel to `pendingApprovals`):

```ts
interface PendingQuestion {
  questionId: string;
  question: string;
  options?: string[];
  placeholder?: string;
  resolve: (answer: string) => void;
}

pendingQuestions: Record<sessionId, PendingQuestion[]>
```

New actions:
- `addPendingQuestion(sessionId, question)`
- `removePendingQuestion(sessionId, questionId)`

`useSessionEvents` hook subscribes to `SESSION_QUESTION_REQUIRED` and calls
`addPendingQuestion`, storing a `resolve` that calls `ipc.answerQuestion()`.

### Frontend — `QuestionCard`

New component rendered in `TimelinePanel` below messages and approvals, one card per
pending question.

Layout:
- **Header**: info/blue styling (visually distinct from amber approval gate), question
  icon, label "Claude is asking…"
- **Question text**: prominent, readable
- **Options row** (if `options` provided): `Suggestion` + `Suggestions` components from
  AI Elements — clicking pre-fills the text input
- **Text input**: `placeholder` from the tool call, or generic "Your answer…"
- **Submit button**: sends answer via `ipc.answerQuestion()`, removes card from store

On submit:
1. Call `resolve(answer)` → `ipc.answerQuestion(sessionId, questionId, answer)`
2. `removePendingQuestion(sessionId, questionId)`

### No Changes To

- `electron/agent/claude.ts` or `electron/agent/copilot.ts`
- The approval gate or its IPC channels
- Message rendering or message types
- SQLite schema (question answers are ephemeral)

## Error Handling

- If the session ends or errors while a question is pending, `removePendingQuestion`
  is called in the `SESSION_STATUS` handler to clean up orphaned cards.
- If the user submits an empty answer, prevent submission (require non-empty text).
- If `ipc.answerQuestion` throws, keep the card visible and show an inline error.

## Testing

- Render test: `QuestionCard` with no options renders question + input + submit.
- Render test: `QuestionCard` with options renders `Suggestion` buttons.
- Interaction: clicking a suggestion pre-fills input.
- Interaction: clicking submit calls `onAnswer` with correct value.
- Interaction: submit is disabled when input is empty.
- Store test: `addPendingQuestion` / `removePendingQuestion` actions.

## Out of Scope

- Copilot provider support (would need Copilot MCP equivalent)
- Multi-question batching (each call blocks until answered)
- Answer history / persisting Q&A pairs in SQLite
- Markdown rendering in questions (plain text only for now)
