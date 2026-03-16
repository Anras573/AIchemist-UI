# AIchemist-UI — Copilot Instructions

## Project Overview

AIchemist-UI is a **Tauri v2 desktop AI assistant** — a React/TypeScript frontend running in a WebView over a Rust backend. The app lets users point it at a project directory and chat with an LLM agent that can read/write files, run shell commands, and fetch URLs.

---

## Commands

```bash
# Full dev environment (Vite + Rust hot-reload)
bun run tauri dev

# Frontend-only (no Rust, port 1420)
bun run dev

# Type-check only
bun run build          # tsc && vite build

# Production build
bun run tauri build

# Rust tests only
cargo test --manifest-path src-tauri/Cargo.toml

# Single Rust test
cargo test --manifest-path src-tauri/Cargo.toml <test_name>
```

> Vite is locked to port **1420** (`strictPort: true`). If that port is occupied, `tauri dev` will fail.

There are no frontend tests currently. TypeScript strict mode is enabled with `noUnusedLocals` and `noUnusedParameters` — unused variables are compile errors.

---

## Architecture

### Two-process model

| Layer | Location | Language | Entry point |
|---|---|---|---|
| Frontend (WebView) | `src/` | TypeScript / React 19 | `src/main.tsx` → `src/App.tsx` |
| Backend (native) | `src-tauri/src/` | Rust | `main.rs` → `lib.rs` |

**Frontend → Backend:** `invoke("command_name", { args })` from `@tauri-apps/api/core`  
**Backend → Frontend:** Tauri events via `listen("session:*")` (see `useSessionEvents.ts`)  
**New Tauri commands:** add `#[tauri::command]` fn in the appropriate Rust module, register in `lib.rs`'s `invoke_handler!` macro  
**New permissions:** add to `src-tauri/capabilities/default.json` (Tauri v2 is explicit opt-in)

### Rust backend modules

| Module | Role |
|---|---|
| `lib.rs` | App entry, shared `AppState { db: Mutex<Connection> }`, registers all commands |
| `config.rs` | Reads env vars for API keys; mirrors Claude Code's env var names |
| `db.rs` | Opens `~/.aichemist/aichemist.db`; forward-only `migrate()` — append only, never modify existing SQL |
| `projects.rs` | CRUD for projects + per-project JSON config |
| `sessions.rs` | CRUD for sessions and messages |
| `tools.rs` | Filesystem, shell (`execute_bash`), and `web_fetch` commands |

### Frontend data flow

1. User message → `useAgentTurn.sendMessage()` (hook)
2. Persists user message via `invoke("save_message")` → SQLite
3. Calls `runAgentTurn()` (`src/lib/ai/agent.ts`) — streams one LLM step at a time via `stopWhen: stepCountIs(1)`
4. Each step: stream parts update Zustand store (`appendStreamingDelta`, `addLiveToolCall`, etc.)
5. Approval-gated tools pause the loop via `Promise`-based `resolve` stored in `pendingApprovals` Zustand slice
6. On turn completion, assistant message persisted via `invoke("save_message")`

### State management (Zustand)

- `useSessionStore` — sessions, messages, streaming text, live tool calls, pending approvals, terminal output. Only `activeSessionId` is persisted (session data lives in SQLite).
- `useProjectStore` — projects list, active project. Only `activeProjectId` is persisted.

### Database

SQLite at `~/.aichemist/aichemist.db`. Schema: `projects` → `sessions` → `messages` → `tool_calls` (cascade deletes). Config is stored as JSON in `projects.config`.

### API keys / config

Place in `~/.aichemist/.env` — loaded at startup via `dotenvy`. Supported vars:

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | Anthropic key (first wins) |
| `ANTHROPIC_BASE_URL` | Custom proxy endpoint |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override any model ID containing `"sonnet"` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override any model ID containing `"haiku"` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override any model ID containing `"opus"` |
| `OPENAI_API_KEY` | OpenAI key |

---

## Key Conventions

### AI SDK v6 (critical — training data is outdated)

Always read `node_modules/ai/docs/` after installing `ai`. Key v6 changes:

| Deprecated | Current (v6) |
|---|---|
| `maxSteps: n` | `stopWhen: stepCountIs(n)` |
| `parameters: z.object({...})` in `tool()` | `inputSchema: zodSchema(z.object({...}))` |
| `generateObject(...)` | `generateText({ output: Output.object({...}) })` |
| `maxTokens` | `maxOutputTokens` |

**Stream part field names:**
- `tool-call` parts → `.input` (not `.args`)
- `tool-result` parts → `.output` (not `.result`)
- `text-delta` parts → `.text` (not `.textDelta`)
- `tool-approval-request` parts → `.approvalId`, `.toolCallId`, `.toolName`, `.input`

### AI Elements components

The AI Elements skill is installed at `.agents/skills/ai-elements/`. Reference docs for every component live at `.agents/skills/ai-elements/references/<component>.md`.

- Use `@/components/ai-elements/...` (the `@/` alias is required)
- **Do not use `useChat`** from `@ai-sdk/react` — it requires an HTTP endpoint and does not work in Tauri. All AI state is driven from Zustand + `runAgentTurn`.
- **`ModelSelectorTrigger` does not support `asChild`** — style it directly with `className`

### Tool definitions

All AI tools are defined in `src/lib/ai/tools.ts` using:
```ts
tool({
  description: "...",
  inputSchema: zodSchema(z.object({ ... })),
  needsApproval: needsApproval("filesystem" | "shell" | "web"),
  execute: async (args) => invoke<ReturnType>("command_name", args),
})
```
The `needsApproval` function reads the project's `approval_mode` ("all" | "none" | "custom") and per-category `approval_rules`.

### Types

`src/types/index.ts` mirrors Rust structs — field names use **snake_case** to match serde defaults. Do not rename them to camelCase.

### Path alias

`@/` resolves to `src/` — configured in both `vite.config.ts` (`resolve.alias`) and `tsconfig.json` (`paths`). Always use `@/` for non-relative imports within `src/`.

### Package manager

Use **`bun`** (not npm/yarn). Lock file is `bun.lock`.

### Styling

Tailwind CSS v4 (via `@tailwindcss/vite` plugin). UI primitives are shadcn/ui components in `src/components/ui/`. Use `cn()` from `src/lib/utils.ts` for conditional class merging.
