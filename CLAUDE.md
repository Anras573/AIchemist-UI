# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development

```bash
# Start full Tauri dev environment (Vite + Rust backend, hot-reload)
bun run tauri dev

# Frontend-only dev server (no Rust, port 1420)
bun run dev

# Type-check + production build (outputs to src-tauri/target/release)
bun run tauri build

# TypeScript type check only
bun run build   # runs tsc && vite build
```

### Rust (backend)

```bash
# Build Rust backend only
cargo build --manifest-path src-tauri/Cargo.toml

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

**Note:** Vite is locked to port 1420 (`strictPort: true`). If that port is occupied, `tauri dev` will fail.

## AI Elements

The AI Elements skill is installed at `.agents/skills/ai-elements/`. Reference docs for every component live at `.agents/skills/ai-elements/references/<component>.md`.

## AI SDK v6 — Critical API Notes

Training data for the AI SDK is outdated. Always read `node_modules/ai/docs/` after `ai` is installed. Key v6 changes:

| Deprecated | Current (v6) |
|---|---|
| `maxSteps: n` | `stopWhen: stepCountIs(n)` |
| `parameters: z.object({...})` in `tool()` | `inputSchema: zodSchema(z.object({...}))` |
| `generateObject(...)` | `generateText({ output: Output.object({...}) })` |
| `maxTokens` | `maxOutputTokens` |

**Stream part field names** (not what training data says):
- `tool-call` parts: use `.input` (not `.args`)
- `tool-result` parts: use `.output` (not `.result`)
- `text-delta` parts: use `.text` (not `.textDelta`)
- `tool-approval-request` parts: use `.approvalId`, `.toolCallId`, `.toolName`, `.input`

**Approval gate loop** (`src/lib/ai/agent.ts`): uses `stopWhen: stepCountIs(1)` to process one LLM step at a time, awaiting `tool-approval-request` decisions before continuing. Approved/denied decisions are injected as `{ role: "tool", content: [{ type: "tool-approval-response", approvalId, approved }] }` messages. `PendingApproval.resolve` in Zustand stores the raw Promise resolver so the UI can unblock the agent loop directly.

---

## AI Elements

**Critical — no `useChat`:** All AI Elements examples use `useChat` from `@ai-sdk/react`, which requires an HTTP endpoint and **does not work in Tauri**. This project drives AI Elements components from its own `streamText`-based state. Do not use `useChat` or `addToolApprovalResponse`.

**`@/` alias required** for all AI Elements imports (`@/components/ai-elements/...`). Must be set in both `vite.config.ts` (`resolve.alias`) and `tsconfig.json` (`paths`).

**`ModelSelectorTrigger` does not support `asChild`** — style it directly with `className`.

---

## Anthropic Environment Variables

The following env vars are read by `src-tauri/src/config.rs` and applied in `src/lib/ai/providers.ts`. Place them in `~/.aichemist/.env` (loaded at startup via `dotenvy`).

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Primary API key |
| `ANTHROPIC_AUTH_TOKEN` | Fallback API key (checked when `ANTHROPIC_API_KEY` is absent) |
| `ANTHROPIC_BASE_URL` | Custom base URL / proxy endpoint |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override any model whose ID contains `"sonnet"` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override any model whose ID contains `"haiku"` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override any model whose ID contains `"opus"` |

Model overrides match by substring (e.g. `claude-sonnet-4-6` → overridden by `ANTHROPIC_DEFAULT_SONNET_MODEL`), matching Claude Code's behaviour.

---

## Architecture

This is a **Tauri v2** desktop application with a React + TypeScript frontend and a Rust backend.

### Two-process model

| Layer | Location | Language | Entry point |
|---|---|---|---|
| Frontend (WebView) | `src/` | TypeScript / React 19 | `src/main.tsx` → `src/App.tsx` |
| Backend (native) | `src-tauri/` | Rust | `src-tauri/src/main.rs` → `src-tauri/src/lib.rs` |

The frontend and backend communicate exclusively through **Tauri commands**:

- **Frontend → Backend:** `invoke("command_name", { args })` from `@tauri-apps/api/core`
- **Backend → Frontend:** Tauri events or command return values
- **Define commands in Rust:** `#[tauri::command]` attribute on `fn` in `lib.rs`, registered via `invoke_handler!(tauri::generate_handler![cmd_name])`

### Capabilities / permissions

`src-tauri/capabilities/default.json` controls what the WebView window is allowed to do. Tauri v2 uses an explicit opt-in permission model per window — add new plugin permissions here before they will work in the frontend.

### Key structural notes

- `src-tauri/src/lib.rs` is the real app entry point — `main.rs` just calls `lib::run()`. The `lib` crate type (`staticlib`/`cdylib`/`rlib`) supports both desktop and mobile targets from one codebase.
- `build.rs` runs `tauri_build::build()` — required for Tauri's compile-time code generation (ACL schema, etc.). Do not remove it.
- TypeScript strict mode is enabled with `noUnusedLocals` and `noUnusedParameters` — unused variables are compile errors.
- Package manager is **bun** (see `bun.lock`). Use `bun` instead of `npm`/`yarn`.
