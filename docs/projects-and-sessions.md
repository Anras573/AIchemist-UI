# Projects & sessions

## Projects

A **project** is a folder the AI works in. The project sidebar (left edge) lists your projects; the **+** button opens a native folder picker to add one.

Each project has its own settings:

- **Default provider and model** — used when you create a session with the plain **+** button.
- **Approval mode** — how tool calls are gated (see [Tool approvals](#tool-approvals)).
- **Git worktree per session** — isolate each session's changes (see [Worktrees](#git-worktrees-per-session)).

## Sessions

A **session** is one conversation with an agent, shown as a tab in the session tab bar.

- The **+** button creates a session with the project's default provider.
- The **chevron** next to it opens a menu to pick a provider explicitly. Providers that can't run on your machine are greyed out with the reason.
- When a project has no sessions yet, the empty state offers the same per-provider choice.

**Each session is locked to one provider for its lifetime.** This is deliberate: providers can't resume each other's conversation state, so switching mid-session would silently lose context. To try another provider, open a new session — the same project can have Claude, Copilot, Codex, Ollama, and OpenAI-compatible sessions side by side.

Other things on a session:

- **Model picker** — switch models within the session's provider.
- **Agent picker** — select an agent (a reusable system prompt); the chosen agent shows as a small bot badge on the tab. See [Agents & skills](agents-and-skills.md).
- **Status dot** — idle, running, or error. If the app crashes mid-turn, the session is marked as errored on next launch rather than stuck "running".
- Chat history is stored locally in SQLite and reloads when you return to a session.

## Tool approvals

Agents can read files freely, but **writing files, running shell commands, and fetching URLs pause for your approval** by default. An approval dialog shows exactly what the agent wants to do; you approve or deny.

The project's **approval mode** controls this:

| Mode | Behaviour |
|---|---|
| **All** | Every gated tool call asks for approval. |
| **None** | Nothing asks — the agent acts freely. Use with care. |
| **Custom** (default) | Per-tool rules decide which calls ask and which are pre-trusted. |

You can also allow a tool for the rest of the session directly from the approval dialog. Codex sessions bridge the Codex agent's own command/file-write requests into the same dialogs.

## Interactive questions

Agents can ask *you* questions mid-task. A **question card** appears in the timeline — sometimes with preset options, sometimes free-text. The agent waits for your answer before continuing. Unanswered cards from a previous turn are cleared when a new turn starts.

## Built-in terminal

Every session includes a real interactive terminal (your `$SHELL`, starting in the project directory). Use it to run tests, inspect git state, or fix things yourself without leaving the app — it's the same working directory the agent uses.

## The context panel

The panel on the right side of a session gives you tabs for everything around the conversation:

- **Skills** — toggle reusable context packs on/off for this session ([details](agents-and-skills.md#skills)).
- **MCP** — see and toggle MCP servers for this session ([details](mcp-servers.md)).
- **Memory** — the agent's persistent notes for this project ([details](memory-and-traces.md#memory)).
- **Changes** — files the agent has created or modified this session, with a file viewer.
- **GitHub** — open PRs and issues for the project's repository, with CI status badges. You can link an issue to a session or start a new session from an issue so the agent gets its context.
- **Traces** — a structured timeline of every agent turn and tool call ([details](memory-and-traces.md#traces)).
- **Spending** — estimated cost of your usage ([details](spending.md)).

The Skills, MCP, and Memory tabs automatically show content relevant to the session's provider.

## Git worktrees per session

For projects under git, enable **"Create a worktree per session"** in project settings to give each session its own [git worktree](https://git-scm.com/docs/git-worktree). Sessions then can't step on each other's edits — each one works on its own branch in its own directory, while the project root remains the canonical repository.

- You can override where managed worktrees are created (**worktree root path**).
- Deleting a session offers to clean up its worktree and branch.
- If worktree creation fails, the session falls back to the shared project directory rather than failing.
