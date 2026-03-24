# Next Features: Skills Injection, Tracing Panel, Edit Agents/Skills

Date: 2026-03-24

## Context

Previous work (all committed to main):
- "Agents" tab renamed to "Skills"; agent picker moved to VS Code-style input bar dropdown
- Agent selection persisted to `sessions.agent` in SQLite
- Agent badge shown on session tabs (all tabs, not just active)
- Full Copilot SDK agent support (file-based, `session.rpc.agent.select`)

---

## Feature 1: Skills — selection + injection into the conversation

### Current state
`SkillsPanel.tsx` lists skills (directory-based, from `.agents/skills/` + `~/.claude/skills/`)
as read-only cards. No selection, no injection into the agent context.

### What "inject" means
A skill is a directory containing a `SKILL.md` (frontmatter + body) that defines a capability.
Injecting a skill means appending its content to the agent's system prompt for that session.

### Approach: session-persistent toggling
The user enables one or more skills from the Skills panel; they stay active for the whole
session. Same mental model as the agent picker — "set and forget" per session.
(VS Code-style per-message @-mention injection is a possible future enhancement.)

### Implementation steps

1. **Store**: add `sessionSkills: Record<sessionId, string[]>` to `useSessionStore`.
   Restore from SQLite via `hydrateSession` (same pattern as `sessionAgents`).

2. **DB migration**: `ALTER TABLE sessions ADD COLUMN skills TEXT` (JSON-encoded array).

3. **IPC**: new channel `UPDATE_SESSION_SKILLS` wired through
   `ipc-channels.ts` → `main.ts` → `preload.ts` → `ipc.ts`.

4. **`SkillsPanel.tsx`**: make `SkillCard` clickable/toggleable with a checkmark when active.
   On toggle: call `ipc.updateSessionSkills(sessionId, skills)`, update Zustand.

5. **Agent runners — skill content injection**:
   - Read active skills from the session record before running each agent turn.
   - For each active skill, read its `SKILL.md` content from disk.
   - Append skill content to the system prompt.
   - Both `electron/agent/claude.ts` and `electron/agent/copilot.ts` need this.

6. **`sessions.ts`**: add `skills` to all queries + new `updateSessionSkills()` function.

### Key files
- `src/components/session/SkillsPanel.tsx`
- `src/lib/store/useSessionStore.ts`
- `electron/db.ts`, `electron/sessions.ts`, `electron/ipc-channels.ts`
- `electron/main.ts`, `electron/preload.ts`, `src/lib/ipc.ts`
- `electron/agent/claude.ts`, `electron/agent/copilot.ts`

---

## Feature 2: Simple in-app performance/tracing panel

### Agreed scope
Phase 1: instrument key operations ourselves (no full OTEL stack).
Phase 2 (future): embed a lightweight OTEL collector subprocess inside Electron
(e.g., `@opentelemetry/sdk-node`), then build toward a full in-app trace viewer.

### Reality check on SDK OTEL support
- **Claude SDK**: only exposes `otelHeadersHelper` (path to a script that outputs auth
  headers for an *external* collector) — no in-process hooks.
- **Copilot SDK**: only exposes request correlation IDs (`x-github-request-id`) — no OTEL.

Phase 1 therefore instruments the application layer, not the SDKs.

### What to instrument (Phase 1)
- Agent turn: start time, end time, total duration, status (success/error)
- Tool calls: name, start, end, duration, success/error
- Streaming: first-token latency

### Implementation steps

1. **`electron/tracer.ts`** (new): lightweight in-memory span store.
   Each span: `{ id, parentId, sessionId, name, startMs, endMs, status, metadata }`.
   Keep last N turns (e.g. 100 spans) in a circular buffer. Expose `startSpan()`,
   `endSpan()`, `getSpans()`.

2. **Instrument runners**: `claude.ts` and `copilot.ts` call `tracer.startSpan()` /
   `tracer.endSpan()` around turns and tool calls.

3. **IPC**: `GET_TRACES` channel returns recent spans. Optionally push live trace events
   to renderer via `webContents.send(SESSION_TRACE, span)`.

4. **`src/components/session/TracesPanel.tsx`** (new): new `"traces"` tab in
   `ContextPanel`. Shows a list of turns → expandable tree of tool call spans with
   relative timing bars.

### Key files
- `electron/tracer.ts` (new)
- `electron/agent/claude.ts`, `electron/agent/copilot.ts`
- `src/components/session/TracesPanel.tsx` (new)
- `src/components/session/ContextPanel.tsx` (add traces tab)
- `src/components/session/ToolStrip.tsx` (add traces tab icon)
- `electron/ipc-channels.ts`, `electron/preload.ts`, `src/lib/ipc.ts`

---

## Feature 3: Edit / create / delete skills and agents in-app

### Agreed scope
Application-managed files only:

| Resource | Location | Editable |
|---|---|---|
| User agents (Claude) | `~/.claude/agents/*.md` | ✅ |
| Project agents (Copilot) | `{project}/.agents/copilot-agents/*.md` | ✅ |
| Global agents (Copilot) | `~/.github-copilot/agents/*.md` | ✅ |
| Project skills | `{project}/.agents/skills/` (SKILL.md) | ✅ |
| Global skills | `~/.claude/skills/` (SKILL.md) | ✅ |
| SDK built-in agents | From `supportedAgents()` | ❌ read-only |

### Phase 1: Agents (simpler — single .md file per agent)

1. Add edit/delete icons to each item in the `AgentPickerButton` dropdown.
   Add a "New agent" entry at the bottom of the list.

2. New `src/components/session/AgentEditorModal.tsx`: sheet/modal with a simple
   `<textarea>` editor (monospace font). Shows raw file content (frontmatter + body).
   Save writes back to disk via IPC.

3. **IPC channels**: `READ_AGENT_FILE`, `WRITE_AGENT_FILE`, `DELETE_AGENT_FILE`,
   `CREATE_AGENT_FILE` — wired through all layers.

4. After save/delete, re-fetch agents to refresh the picker dropdown.

### Phase 2: Skills (directory-based, more involved)
- Edit `SKILL.md` inside an existing skill directory.
- Create: scaffold a new directory with a blank `SKILL.md`.
- Delete: remove the entire skill directory.

### Key files
- `src/components/session/AgentPickerButton.tsx`
- `src/components/session/AgentEditorModal.tsx` (new)
- `electron/ipc-channels.ts`, `electron/main.ts`, `electron/preload.ts`, `src/lib/ipc.ts`

---

## Recommended implementation order

| # | Feature | Complexity | Why |
|---|---|---|---|
| 1 | Skills injection | Medium | Infrastructure already in place; high UX value |
| 2 | Tracing panel | Medium | Standalone new capability; no dependencies |
| 3 | Edit agents/skills | Medium | Nice-to-have; can be done incrementally |
