# AI Elements Migration — Custom Component Audit

Date: 2026-04-01

## Problem

The codebase has grown a number of hand-rolled UI components that duplicate functionality
already provided by the AI Elements component library. This creates visual inconsistency,
extra maintenance burden, and means we miss out on features (stick-to-bottom scroll,
copy buttons, Shiki syntax highlighting, etc.) that AI Elements provides for free.

The existing conversation UI already uses `MessageResponse`, `Reasoning`, `Tool`, and
`CodeBlock` successfully. The goal is to complete the migration for the remaining
components.

## Scope

Six targeted swaps, ordered by impact. No backend, IPC, or store changes required for
any of them — these are pure UI replacements.

---

## Phase 1 — High Impact

### 1. Scroll container → `Conversation`

**File:** `src/components/session/TimelinePanel.tsx`

**Problem:** The timeline currently uses a manual `useRef` + `useEffect` scroll-to-bottom
approach. It doesn't handle the "user is scrolled up reading history" case — new messages
keep snapping the view to the bottom.

**Replacement:** Wrap the message list with `Conversation` + `ConversationContent` from
`@/components/ai-elements/conversation`. Add `ConversationScrollButton` for a
"scroll to bottom" affordance when the user is scrolled up.

| Current | Replacement |
|---|---|
| `<div ref={scrollRef}>` with `useEffect` scroll | `<Conversation>` (stick-to-bottom) |
| Manual scroll logic | `<ConversationContent>` |
| No scroll button | `<ConversationScrollButton>` |
| Custom empty state `<div>` | `<ConversationEmptyState>` |

**Notes:**
- `Conversation` is built on `stick-to-bottom`, which only auto-scrolls when the user is
  already at the bottom — preserving scroll position when reading history.
- The empty state (no active session / no messages) can use `ConversationEmptyState`
  with the existing "Create a new session" button slotted in.

---

### 2. `MessageBubble` → `Message` + `MessageContent`

**File:** `src/components/session/TimelinePanel.tsx`

**Problem:** `MessageBubble` is a bare `div` with inline styles for user vs assistant
alignment. It doesn't support actions, copy, or branching.

**Replacement:** Use `Message` + `MessageContent` from `@/components/ai-elements/message`.

| Current | Replacement |
|---|---|
| `<div className="flex justify-end/start">` | `<Message>` with `from` prop |
| `<div className="bg-primary ...">` | `<MessageContent>` |
| Manual role check for alignment | `from="user"` or `from="assistant"` |
| No actions | `<MessageActions>` slot (copy, etc.) |

**Notes:**
- The agent name label added in the previous session (above the bubble) should be
  preserved as a slot above `<Message>`.
- Keep `MessageResponse` inside `MessageContent` for assistant messages (markdown render).

---

## Phase 2 — Medium Impact

### 3. `TracesPanel` `TurnCard` → `Task`

**File:** `src/components/session/TracesPanel.tsx`

**Problem:** `TurnCard` is a hand-rolled collapsible with a custom expand button,
`ChevronRight` rotation, status dot, and tool rows. This is exactly what the `Task`
component family provides.

**Replacement:** `Task` + `TaskTrigger` + `TaskContent` + `TaskItemFile` from
`@/components/ai-elements/task`.

| Current | Replacement |
|---|---|
| `<div className="rounded-md border">` wrapper | `<Task>` |
| Custom `<button>` with ChevronRight | `<TaskTrigger>` (with status + duration) |
| `{expanded && <div>}` tool rows | `<TaskContent>` |
| `ToolRow` per-tool line | `<TaskItem>` or `<TaskItemFile>` |

**Notes:**
- `StatusDot` inside TracesPanel is local and can stay — just change the container.
- Duration display and tool count badge go into `TaskTrigger`.

---

### 4. `InteractiveTerminal` chrome → `Terminal` wrapper

**File:** `src/components/session/InteractiveTerminal.tsx`

**Problem:** The interactive terminal has no header chrome — no title bar, no copy
button, no clear button. The xterm.js canvas is rendered raw.

**Replacement:** Wrap the existing xterm.js container with `Terminal` +
`TerminalHeader` + `TerminalTitle` + `TerminalActions` + `TerminalCopyButton` +
`TerminalClearButton` + `TerminalContent` from `@/components/ai-elements/terminal`.

| Current | Replacement |
|---|---|
| Raw `<div ref={terminalRef}>` | `<Terminal>` + `<TerminalContent>` |
| No header | `<TerminalHeader>` + `<TerminalTitle>` |
| No copy/clear | `<TerminalCopyButton>` + `<TerminalClearButton>` |
| No status | `<TerminalStatus>` (running/idle indicator) |

**Notes:**
- The xterm.js instance itself (`Terminal` from `@xterm/xterm`) is unchanged — the
  AI Elements `Terminal` is purely the surrounding chrome/layout.
- Copy should grab `terminalOutputRef` text; clear should call `terminal.clear()`.
- Watch for naming conflict: the AI Elements `Terminal` export and `@xterm/xterm`'s
  `Terminal` class will both need to be in scope — alias one on import.

---

### 5. `ChangesPanel` `DiffView` → `CodeBlock` with `language="diff"`

**File:** `src/components/session/ChangesPanel.tsx`

**Problem:** `DiffView` manually colours `+`/`-` lines with Tailwind classes. Shiki
(which `CodeBlock` uses) has a built-in `diff` language that handles this with proper
syntax highlighting, including inline word-level diffs.

**Replacement:** Replace the `<pre>` + manual line colouring in `DiffView` with
`<CodeBlock code={patch} language="diff" />` from `@/components/ai-elements/code-block`.

| Current | Replacement |
|---|---|
| `<pre>` with per-line `split("\n")` | `<CodeBlock>` |
| Manual `text-green-*` / `text-red-*` per line | Shiki `diff` language theme |
| No copy button | `CodeBlock` includes copy button |

---

## Phase 3 — Polish

### 6. `StreamingBubble` dots → `Shimmer`

**File:** `src/components/session/TimelinePanel.tsx`

**Problem:** The three-dot bounce animation in `StreamingBubble` is custom CSS. The AI
Elements `Shimmer` component provides a more refined animated text shimmer for loading
states, consistent with the design system.

**Replacement:** When `text` is empty (model is "thinking" before first token), replace
the bounce dots with `<Shimmer>` from `@/components/ai-elements/shimmer`. When `text`
is non-empty, keep the existing `<MessageResponse>` streaming render.

---

## Implementation Order

1. `Conversation` scroll container (unblocks correct scroll behaviour for everything else)
2. `MessageBubble` → `Message`
3. `TracesPanel` → `Task`
4. `InteractiveTerminal` chrome → `Terminal`
5. `ChangesPanel` → `CodeBlock diff`
6. `StreamingBubble` → `Shimmer`

## Out of Scope

- `AgentPickerButton`, `ModelPickerButton` — domain-specific, no equivalent
- `AgentsPanel`, `SkillsPanel` — functional, lower ROI
- `SessionTabBar` — would require significant restructure
- `ChangesPanel` git diff section — keeping custom layout for the two-section design
- No IPC, store, or backend changes in any phase
