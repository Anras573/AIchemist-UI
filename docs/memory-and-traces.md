# Memory & traces

## Memory

Agents can keep **persistent notes per project** — conventions they've learned, decisions you've made, quirks of the codebase. Notes survive across sessions: an agent can write a note today and recall it in a fresh session next week.

- Agents manage notes themselves with `write_memory` / `read_memory` / `delete_memory` tools; relevant notes are also injected into their context automatically.
- The **Memory** tab in the session's right panel shows the notes for the current project, so you can see (and audit) what the agent remembers.
- Storage: Claude sessions use the Claude SDK's own memory store (`~/.claude/projects/...`); all other providers share one per-project store under `~/.aichemist/memory/`, so a note written in an Ollama session is available to a Copilot or Codex session on the same project.

## Traces

The **Traces** tab shows a structured timeline of everything that happened in a session: each turn, the tools it called with their inputs and results, reasoning summaries, and token usage.

Use it to answer "what did the agent actually do?" — especially after a long multi-tool turn or a [workflow](workflows.md) run you didn't watch.

- Traces are parsed from each provider's on-disk session transcript, so they're complete and survive restarts.
- A session has traces only after its **first completed turn** — before that, the tab is empty.
- While a turn is running, the trace updates live.
