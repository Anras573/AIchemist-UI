# AIchemist UI

AIchemist UI is a desktop AI assistant for your codebase. Point it at a project folder and chat with an AI agent that can read and write files, run shell commands, and fetch URLs — with you in control of what it's allowed to do.

It works with multiple AI providers side by side: **Anthropic Claude**, **GitHub Copilot**, **OpenAI Codex**, **Ollama** (fully local), and any **OpenAI-compatible endpoint** (LM Studio, vLLM, llama.cpp, Together, and more).

## Documentation

### Start here

- **[Getting started](getting-started.md)** — install, configure a provider, and run your first session.
- **[Providers](providers.md)** — set up Anthropic, Copilot, Codex, Ollama, and OpenAI-compatible endpoints.

### Everyday use

- **[Projects & sessions](projects-and-sessions.md)** — projects, chat sessions, models, tool approvals, the built-in terminal, and Git worktrees.
- **[Agents & skills](agents-and-skills.md)** — reusable system prompts (agents), reusable context packs (skills), and slash commands.
- **[MCP servers](mcp-servers.md)** — connect external tools to your agents via the Model Context Protocol.

### Automation & insight

- **[Workflows](workflows.md)** — schedule repeatable agent tasks on a cron schedule, a file watcher, or on demand.
- **[Memory & traces](memory-and-traces.md)** — persistent per-project notes and a detailed trace of every agent turn.
- **[Spending & budgets](spending.md)** — track estimated costs per provider and set spending budgets.

### Reference

- **[Settings reference](settings-reference.md)** — every app setting and configuration file.
- **[Troubleshooting](troubleshooting.md)** — fixes for common problems.

## Highlights

- **Multi-provider, per-session** — each chat session is locked to one provider, but different sessions in the same project can use different providers. Compare Claude and a local Ollama model on the same codebase, side by side.
- **You approve the tools** — file writes, shell commands, and web fetches pause for your approval (configurable per project, down to per-tool rules).
- **Real terminal built in** — a full interactive shell, scoped to your project directory, lives next to the chat.
- **Skills, agents, and MCP** — shape how the AI works with reusable prompts and context, and extend it with external tools.
- **Automation** — schedule workflows that run agent tasks unattended, with clear guardrails.
- **Local-first** — everything is stored on your machine in SQLite and plain config files under `~/.aichemist/`.
