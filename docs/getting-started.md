# Getting started

This guide takes you from a fresh checkout to your first AI-assisted session.

## Prerequisites

- **[Bun](https://bun.sh)** — the project's package manager and script runner.
- **Node.js toolchain** — Electron and its native modules build against Node.
- At least one AI provider you can use (see [Providers](providers.md)):
  - an Anthropic API key or a Claude Pro/Max login,
  - a GitHub token with Copilot access,
  - an OpenAI API key (for Codex),
  - a locally running [Ollama](https://ollama.com) with at least one model pulled, or
  - any OpenAI-compatible server (LM Studio, vLLM, llama.cpp, …).

## Install and run

```bash
bun install
bun run dev
```

`bun run dev` starts the Electron app with hot reload. For a production build:

```bash
bun run build
bun run start   # preview the production build
```

If native modules complain after an Electron upgrade, rebuild them:

```bash
bun run rebuild
```

## Configure a provider

API keys live in a single file: `~/.aichemist/.env`. Create it and add the key(s) for the providers you plan to use:

```ini
# Anthropic Claude
ANTHROPIC_API_KEY=sk-ant-...

# GitHub Copilot
GITHUB_TOKEN=ghp_...

# OpenAI (Codex provider)
OPENAI_API_KEY=sk-...
```

Notes:

- **Claude Pro/Max users:** if you're logged in via the Claude CLI (`~/.claude/.credentials.json` exists), no Anthropic key is needed.
- **Ollama** needs no key — just have the Ollama daemon running.
- **OpenAI-compatible endpoints** are configured in the app under **Settings → Providers**, not in `.env`.

The full list of supported variables is in the [Settings reference](settings-reference.md). Restart the app after editing `.env` — it's loaded at startup.

## Create a project

A **project** is a folder on disk that the AI works in.

1. Click **+** in the project sidebar.
2. Pick a folder with the native folder picker.
3. Optionally open the project's settings to choose a default provider, model, and approval mode.

## Start a session

A **session** is one conversation with an agent. Each session is locked to a single provider when it's created.

- Click the **+** button in the session tab bar to create a session with the project's default provider, or
- click the **chevron** next to it to pick a specific provider for this session.

Providers that aren't usable on your machine (missing key, Ollama not running) appear greyed out with the reason — see [Troubleshooting](troubleshooting.md) if something you expect to work is unavailable.

Type a message and send it. When the agent wants to write a file, run a command, or fetch a URL, you'll get an **approval prompt** first — approve or deny each action. You can loosen or tighten this per project (see [Projects & sessions](projects-and-sessions.md#tool-approvals)).

## Where your data lives

Everything is local:

| Data | Location |
|---|---|
| Chat history, projects, sessions | `~/.aichemist/aichemist.db` (SQLite) |
| API keys | `~/.aichemist/.env` |
| App settings | `~/.aichemist/` (JSON files) |
| MCP server config | `~/.aichemist/mcp.json` |
| OpenAI-compatible endpoints | `~/.aichemist/openai-providers.json` |
| Spending budget | `~/.aichemist/budget.json` |

## Next steps

- Set up more [providers](providers.md).
- Learn the session workspace in [Projects & sessions](projects-and-sessions.md).
- Add reusable prompts and context with [Agents & skills](agents-and-skills.md).
- Connect external tools via [MCP servers](mcp-servers.md).
