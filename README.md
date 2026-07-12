# AIchemist UI

A desktop AI assistant that lets you point it at a project directory and chat with an LLM agent that can read/write files, run shell commands, and fetch URLs — with tool approvals, skills, agents, MCP servers, scheduled workflows, and spend tracking built in.

Built with **Electron**, **React 19**, and **TypeScript**.

## Documentation

**User documentation lives at [anras573.github.io/AIchemist-UI](https://anras573.github.io/AIchemist-UI/)** (published from the [`docs/`](docs/index.md) folder):

- [Getting started](docs/getting-started.md)
- [Providers](docs/providers.md) — Anthropic Claude, GitHub Copilot, OpenAI Codex, Ollama, OpenAI-compatible endpoints
- [Projects & sessions](docs/projects-and-sessions.md)
- [Agents & skills](docs/agents-and-skills.md)
- [MCP servers](docs/mcp-servers.md)
- [Workflows](docs/workflows.md)
- [Memory & traces](docs/memory-and-traces.md)
- [Spending & budgets](docs/spending.md)
- [Settings reference](docs/settings-reference.md)
- [Troubleshooting](docs/troubleshooting.md)

Internal design notes and plans live in [`notes/`](notes/) and are not published.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 36 |
| Frontend | React 19 + TypeScript + Tailwind CSS v4 |
| Build tool | electron-vite |
| Backend (main process) | Node.js / TypeScript |
| Database | SQLite via better-sqlite3 |
| AI providers | Anthropic Claude, GitHub Copilot, OpenAI Codex, Ollama, OpenAI-compatible endpoints |
| Package manager | bun |

## Project Structure

```
electron/          # Main process (Node.js backend)
  agent/           # AI provider runners (Claude, Copilot, Codex, Ollama, OpenAI-compat)
  ipc/             # Domain-specific IPC handler modules
  main.ts          # App entry, BrowserWindow, handler registration
  preload.ts       # contextBridge — exposes window.electronAPI to renderer
  ipc-channels.ts  # Shared IPC channel name constants
  config.ts        # Env var loading, API key resolution
  db.ts            # SQLite setup and migrations
  projects.ts      # Project CRUD
  sessions.ts      # Session & message CRUD
  settings.ts      # App-level settings

src/               # Renderer process (React frontend)
  components/      # UI components
  lib/             # Stores (Zustand), hooks, IPC wrapper, AI utilities
  types/           # Shared TypeScript types

docs/              # User documentation (published to GitHub Pages)
notes/             # Internal design docs and planning files (not published)
```

## Development

```bash
# Install dependencies
bun install

# Start dev environment (main + renderer with hot-reload)
bun run dev

# Run the test suite
bun run test

# Type-check both src/ and electron/
bun run typecheck

# Production build
bun run build

# Preview production build
bun run start

# Rebuild native modules (e.g. after Electron version bump)
bun run rebuild
```

## Configuration

API keys go in `~/.aichemist/.env` — see the [settings reference](docs/settings-reference.md) for every supported variable and configuration file, and the [provider guide](docs/providers.md) for per-provider setup.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) with the [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) and [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) extensions.
