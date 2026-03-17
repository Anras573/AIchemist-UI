# AIchemist UI

A desktop AI assistant that lets you point it at a project directory and chat with an LLM agent that can read/write files, run shell commands, and fetch URLs.

Built with **Electron**, **React 19**, and **TypeScript**.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 36 |
| Frontend | React 19 + TypeScript + Tailwind CSS v4 |
| Build tool | electron-vite |
| Backend (main process) | Node.js / TypeScript |
| Database | SQLite via better-sqlite3 |
| AI | Anthropic Claude, GitHub Copilot |
| Package manager | bun |

## Project Structure

```
electron/          # Main process (Node.js backend)
  agent/           # AI agent runners (Claude, Copilot, MCP tools)
  main.ts          # App entry, BrowserWindow, IPC handlers
  preload.ts       # contextBridge — exposes window.electronAPI to renderer
  ipc-channels.ts  # Shared IPC channel name constants
  config.ts        # Env var loading, API key resolution
  db.ts            # SQLite setup and migrations
  projects.ts      # Project CRUD
  sessions.ts      # Session & message CRUD
  dialog.ts        # Native folder picker
  settings.ts      # App-level settings

src/               # Renderer process (React frontend)
  components/      # UI components
  lib/             # Stores (Zustand), hooks, IPC wrapper, AI utilities
  types/           # Shared TypeScript types

docs/              # Documentation site
notes/             # Internal design docs and planning files
```

## Development

```bash
# Install dependencies
bun install

# Start dev environment (main + renderer with hot-reload)
bun run dev

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

Place API keys in `~/.aichemist/.env` — loaded at startup:

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Primary Anthropic key |
| `ANTHROPIC_AUTH_TOKEN` | Fallback Anthropic key |
| `ANTHROPIC_BASE_URL` | Custom proxy endpoint |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override any model ID containing `"sonnet"` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override any model ID containing `"haiku"` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override any model ID containing `"opus"` |
| `OPENAI_API_KEY` | OpenAI key |
| `GITHUB_TOKEN` | GitHub Copilot key |
| `CLAUDE_CODE_PATH` | Explicit path to the `claude` CLI binary |

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) with the [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) and [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) extensions.
