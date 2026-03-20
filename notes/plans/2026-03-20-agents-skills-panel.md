# Agents & Skills Panel

## Problem
Surface Claude's built-in sub-agents (`supportedAgents()`) and locally installed skills
(`.agents/skills/` filesystem scan) in a new ToolStrip panel. Users can browse both
sections and click a Claude agent to set it for the active session.

## Approach: Option A — Zustand-only agent state, no DB migration

Key insight: the Claude SDK `query()` options accept `agent?: string` — passing it applies
that agent's system prompt, tools, and model to the main conversation thread.

## Files changed

### Backend (electron/)
- `ipc-channels.ts` — add `GET_CLAUDE_AGENTS`, `LIST_SKILLS`
- `agent/claude.ts` — add `getClaudeAgents(projectPath)` export; add `agent?` param to `runClaudeAgentTurn`
- `agent/runner.ts` — add `agent?` param, pass through to `runClaudeAgentTurn`
- `main.ts` — register two new IPC handlers; pass `agent` through `AGENT_SEND`
- `preload.ts` — expose `getClaudeAgents`, `listSkills`; update `agentSend` signature

### Shared types + state (src/)
- `types/index.ts` — add `AgentInfo`, `SkillInfo`
- `lib/ipc.ts` — add `getClaudeAgents()`, `listSkills()`; update `agentSend`
- `lib/store/useSessionStore.ts` — add `sessionAgents`, `setSessionAgent`
- `lib/hooks/useAgentTurn.ts` — include active agent in `agentSend` payload

### UI (src/components/)
- `session/AgentsPanel.tsx` — new component: two sections (Agents / Skills)
- `session/ContextPanel.tsx` — add `"agents"` to `ContextTab`, render AgentsPanel
- `session/ToolStrip.tsx` — add Bot icon tab

## Data flow

1. User opens Agents tab → `AgentsPanel` mounts
2. Panel calls `ipc.getClaudeAgents(project.path)` (Claude only) + `ipc.listSkills(project.path)`
3. User clicks an agent → `setSessionAgent(sessionId, agentName)` in Zustand
4. Visual: agent card highlighted; active agent badge shows in panel header
5. User sends next message → `useAgentTurn` reads `sessionAgents[sessionId]` and
   includes `agent` in `ipc.agentSend({ sessionId, prompt, agent })`
6. Main process passes `agent` → runner → `runClaudeAgentTurn` → `query({ options: { agent } })`
7. Claude uses that agent's system prompt + tools for the turn

## Copilot handling
Agents section shows "Sub-agents are not available when using GitHub Copilot" — skills
section still renders normally.

## Skill scanning
`listSkills(projectPath)` scans `<projectPath>/.agents/skills/` for subdirectories.
For each: reads first non-heading line of `README.md` as description (up to 150 chars),
or falls back to the directory name only.
