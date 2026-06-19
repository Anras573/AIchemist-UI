# Memory support for non-Claude providers

**Status:** Proposed
**Date:** 2026-06-19
**Branch:** `claude/memory-other-providers-0rj57o`

## Problem

The Memory panel (`src/components/session/MemoryPanel.tsx`) is hard-gated to
Claude sessions (`provider !== "anthropic"` → "not available" placeholder).
Every other provider sees an empty placeholder.

The reason it's Claude-only is fundamental, not cosmetic: AIchemist does **not
create or manage memory** — it only *views* it. The `LIST_MEMORY` handler
(`electron/ipc/trace-handlers.ts`) lists `.md` files under
`~/.claude/projects/<sanitized-cwd>/memory/`, a directory the **Claude Code SDK
itself** owns and writes via its built-in Memory tool. The panel is a read-only
viewer over SDK-managed files.

The other providers have no equivalent store:

| Provider | Memory situation |
|---|---|
| Copilot | Persists *session state* under `~/.copilot/session-state/`, but no Claude-style per-project memory dir it writes via a memory tool and auto-loads. |
| Ollama | Self-driven native provider. No SDK, no memory concept — replays full history each turn. |
| OpenAI-compatible | Same as Ollama — replays history, no memory store. |

**Therefore "support viewing memory for other providers" is not a viewer-plumbing
task — there is no data to view.** We must *build* a memory subsystem (store +
tools + injection) before there is anything to surface. The viewer half is then
small and mirrors how Skills/MCP were made provider-aware.

## Scope of this plan

Implement memory for **Ollama** first (cleanest — it already has an in-process
tool loop, system-prompt assembly, and uses the `~/.aichemist/` data dir).
OpenAI-compatible reuses the same module afterwards with minimal work. Copilot
is tracked as a follow-up (different registration + injection model).

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Storage location | `~/.aichemist/memory/<sanitized-cwd>/*.md` | Project-scoped like Claude's memory; under the dir AIchemist already owns (mirrors `~/.aichemist/traces/<sessionId>/`). |
| Granularity | Multiple named `.md` files | Matches Claude's model and the existing `MemoryPanel` file-list viewer. |
| Who writes it | The model, via new `write_memory` / `read_memory` / `delete_memory` tools | No SDK memory tool exists for Ollama, so AIchemist must expose one. |
| Injection | `buildMemoryContext()` appended in `buildSystemPrompt()` | Identical to how `buildSkillsContext()` is already injected. |
| Approval | Un-gated (`category: "custom"`) | It's the model's own scratchpad, sandboxed to AIchemist's dir, and emits no project diff. |

### Critical gotcha — memory dir is OUTSIDE the project root

`implWriteFileWithChange` / `implReadTextFile` in `electron/agent/tool-impls.ts`
validate every path against the **project root** (`resolveAndValidate`). The
memory dir lives in `~/.aichemist/`, *outside* the project, so reusing those
impls would throw "Path escapes project boundary."

Consequences:
- Memory needs its **own** impl functions with a boundary check anchored to the
  memory dir (reject `..` traversal, require `.md`).
- Memory writes must **not** emit a `FileChange` — they aren't project edits and
  must stay out of the Changes tab.

## Implementation

### Step 1 — New module `electron/agent/memory.ts`

Mirrors `skills.ts`. Owns path convention, CRUD, and context-building.

- `sanitizeCwd(cwd)` — reuse Claude's convention: `cwd.replace(/\/+$/, "").replace(/[^a-zA-Z0-9-]/g, "-")`.
- `memoryDir(projectPath)` → `~/.aichemist/memory/<sanitizeCwd>`.
- `resolveMemoryFile(projectPath, name)` — resolve against `memoryDir`, reject
  paths escaping it, require a `.md` extension.
- `listMemoryFiles(projectPath)` → `Array<{ name; path }>`, `.md` only, sorted.
- `implWriteMemory` / `implReadMemory` / `implDeleteMemory` — CRUD, no FileChange.
- `buildMemoryContext(projectPath)` — concatenate all memory files into a
  `# Project Memory` system-prompt block (same shape as `buildSkillsContext`);
  empty string when none.

### Step 2 — Wire tools into `electron/agent/ollama.ts`

1. **Inject** memory into `buildSystemPrompt()` — add `buildMemoryContext(params.projectPath)` to the `parts` array.
2. **Mention** the memory tools in `OLLAMA_SYSTEM_PROMPT`.
3. **Define** `write_memory { name, content }`, `read_memory { name }`,
   `delete_memory { name }` in `makeToolDefinitions()`.
4. **Handle** them in `executeTool`'s switch via `runTool(ctx, name, args, "custom", …)`
   — flows through `runGatedTool`, so persistence to `tool_calls` and native-transcript
   recording come for free. Emit **no** `FileChange`.
5. **Delegated turns:** filter the memory tools out of `subTools` in
   `runDelegatedTurn` (alongside `ask_user`) — sub-agent context is ephemeral and
   shouldn't mutate shared project memory.

### Step 3 — Make the viewer provider-aware

Generalize `LIST_MEMORY` exactly how `LIST_SKILLS` was generalized:

- `electron/ipc-contract.ts` — args become `{ projectPath; provider? }` (keep
  accepting a bare string for back-compat, as `LIST_SKILLS` does).
- `electron/ipc/trace-handlers.ts` — branch on provider: `anthropic` keeps
  `resolveProjectDir(projectPath)/memory`; `ollama` reads `memoryDir(projectPath)`.
- `electron/preload.ts` + `src/lib/ipc.ts` — thread the provider arg through.
- `src/components/session/MemoryPanel.tsx` — drop the `provider !== "anthropic"`
  short-circuit; pass the provider into `ipc.listMemory`. Keep gating only
  providers with no store yet (Copilot).
- `src/components/session/ContextPanel.tsx` — replace the hardcoded
  "not supported for Copilot" branch with a `useActiveSessionProvider()` check.

### Step 4 — Tests

Per CLAUDE.md ("new provider runtimes need focused unit tests"):

- `electron/agent/memory.test.ts` — path-traversal rejection (`../foo`,
  non-`.md`), CRUD round-trip, `buildMemoryContext` formatting + empty case
  (in-memory FS mock as in `claude-transcript.test.ts`).
- Extend `electron/agent/ollama.test.ts` — `buildSystemPrompt` includes saved
  memory; a `write_memory` call persists a file and emits no `FileChange`.
- `trace-handlers` test — `LIST_MEMORY` returns Ollama memory for an Ollama session.

## Follow-ups (out of scope here)

- **OpenAI-compatible:** reuse `memory.ts` wholesale; repeat Step 2 in
  `openai-compat.ts` registering tools via `tool()` + `runGatedTool`, and add
  the `ollama`/`openai-compatible` branch to `LIST_MEMORY`.
- **Copilot:** needs `defineTool` registration + `systemMessage` injection of the
  memory block, plus its own store decision. Larger and tracked separately.

## Sequencing

Backend (Steps 1–2) is the substance and makes memory *exist* for Ollama.
Viewer (Step 3) is small and proven. They're independently shippable, but the
viewer is only useful once a store exists, so land backend first.
