# Codex Parity Plan (Epic #116)

Bring the Codex provider to feature parity with the existing providers
(Anthropic / Copilot / Ollama / OpenAI-compatible) for approvals, MCP,
skills/agents, workflows, and traces.

Tracking epic: **#116**. Child issues: #128, #127, #126, #131, #130, #124.

> Status at time of writing: the MVP (epic #117) is complete — Codex runs
> interactive text turns end-to-end (thread start/resume, streamed text +
> usage, probe, settings, model picker). The parity work below is the
> outstanding remainder. Only #124 (skills/agent prompt composition) is
> already substantially implemented.

---

## The linchpin: change the turn loop first

Today `electron/agent/codex.ts` calls `runs.stream(threadId, { model, instructions })`
and reads only `thread.message.delta` (text) and `thread.run.completed` (usage).
The Assistants Runs API delivers tool calls via a **`thread.run.requires_action`**
event and expects the caller to **`submitToolOutputs`** and resume streaming.

Every tool-related parity issue (#127 / #128 / #126) depends on converting the
current one-shot stream into a bounded **`requires_action` loop**:

```
start run (with tools) → stream deltas
  └─ on requires_action:
       for each tool_call → runGatedTool(...) → collect { tool_call_id, output }
       → submitToolOutputs(runId, outputs) → continue streaming
  └─ on completed: emit usage, finish
```

Cap the loop with `readMaxToolRounds()` (the `AICHEMIST_MAX_TOOL_ROUNDS`
setting) exactly like the self-driven providers, and append the
`emitToolRoundLimitNotice()` truncation notice when the cap is hit.

---

## Workstreams

### 1. #128 — Spike: approval/sandbox alignment (decision gate, do first)

Decide how Codex tool calls map onto AIchemist's gate. Output is a short
design note, minimal code.

- Confirm the model: Codex function tools execute **client-side** through
  `runGatedTool` (`electron/agent/tool-gate.ts`), exactly like Ollama /
  OpenAI-compatible — so `requiresApproval()` / `requestApproval()` are reused
  as-is and there is no separate OpenAI "sandbox" to reconcile.
- Decide the tool surface. The FS/shell/web tools mirror
  `electron/agent/tool-impls.ts` (`implWriteFile`, `implDeleteFile`,
  `implExecuteBash`, `implWebFetch`, plus `implReadTextFile` /
  `implListDirectory` / `implGlobFiles` — tools `read_file`,
  `list_directory`, `glob`); decide
  each tool's `ToolCategory` classification. `ask_user` is **not** in
  `tool-impls.ts` — it is registered per-provider and plumbed through
  `electron/agent/question.ts` (`requestQuestion` / `resolveQuestion`), so
  wire it the same way for Codex.
- **Deliverable:** this note + a checklist #127 implements against. Close #128
  when the decision lands.

### 2. #127 — Managed MCP + built-in tool gating

Goal: Codex can use tools, gated identically to other providers.

- Build the `requires_action` loop (above).
- Register built-in tools as Assistants `tools: [{ type: "function", ... }]`;
  route each call through `runGatedTool(ctx, { name, args, category, impl })`,
  reusing the `tool-impls.ts` implementations.
- Construct a `GatedToolContext` in `codex.run()`
  (`db, sessionId, messageId, projectConfig, emitter`). `messageId` is already
  threaded via `AgentProviderParams`.
- **MCP:** load via `loadManagedMcpServers({ excludeNames })` (respect
  `sessions.disabled_mcp_servers`), expose managed servers as function tools
  through the same bridge pattern the other providers use. Tool call/result
  timeline events happen inside `runGatedTool` (`emitter.toolCall/toolResult`).
- **Acceptance:** a Codex session can write a file (with approval prompt), run
  bash, and call a managed MCP tool; rows land in `tool_calls`; the
  `McpServersPanel` per-session disable works.

### 3. #126 — Workflow / autonomous run compatibility

Goal: Codex behaves correctly under unattended scheduled runs.

- Thread `params.nonInteractive` into `GatedToolContext.nonInteractive` — the
  gate already auto-denies un-allowlisted tools when set (no new mechanism).
- Honor `params.noTools` (skip-persistence / PR-draft turns): start the run
  with **no tools** (skip the `requires_action` loop), matching the
  OpenAI-compatible provider's `noTools` handling.
- **Acceptance:** an `autonomous` workflow on a Codex session runs end-to-end;
  trusted tools execute, un-allowlisted ones auto-deny with the unattended
  message; an `interactive` workflow with no window attached still auto-denies
  (covered by `executeAgentTurn` forcing `nonInteractive`).

### 4. #131 — Rich traces parity

Goal: the Traces tab works for Codex.

- Add `createNativeTranscriptRecorder(sessionId, "codex")` to `codex.run()`.
  Call `turnStart(model)` / `turnEnd(status)` in a `finally`, record
  `usage(...)` and any `reasoning(...)`. Pass the recorder into
  `GatedToolContext.recorder` so `runGatedTool` writes `tool_call` /
  `tool_result` events automatically.
- **Wire the dispatcher:** in `electron/ipc/trace-handlers.ts` (~line 96), add
  `codex` to the native branch
  (`effectiveProvider === "ollama" || effectiveProvider === "openai-compatible" || effectiveProvider === "codex"`
  → `{ kind: "native" }`). Without this, traces stay empty even with a recorder.
- **Acceptance:** opening Traces on a Codex session shows turn spans + tool
  spans + usage, live-updating via the watcher.

### 5. #130 — Parity test matrix (last; locks in the above)

- Extend `electron/agent/codex.test.ts` (or add `codex.parity.test.ts`) to
  cover: gated tool approval + rejection, `nonInteractive` auto-deny, MCP tool
  invocation, `noTools` turn, native-transcript event emission
  (turn_start / tool / usage / turn_end).
- Mirror the structure of the OpenAI-compatible tests (closest analog).
- **Acceptance:** the matrix passes and exercises each capability from 2–4.

### Bonus — close out #124's two gaps (cheap; ride along with #131)

- Add `codex` to the `LIST_MEMORY` provider branch in
  `electron/ipc/trace-handlers.ts` (Memory panel listing for Codex sessions).
- Add `codex` to the `AgentPickerButton.tsx` footer condition (~line 262).
- Then #124 can close.

---

## Sequencing

```
#128 (spike / decision)
   └─> #127 (loop + tools + MCP)  ──┬─> #126 (nonInteractive / noTools)
                                    ├─> #131 (recorder + dispatcher)  ──> #130 (tests)
                                    └─> #124 gap-closeouts (with #131)
```

#127 is the critical path — everything hangs off the `requires_action` loop.
#126, #131, and the #124 gaps can proceed in parallel once #127 lands; #130
comes last.

---

## Resolved: migrated to `@openai/codex-sdk`

The earlier open question (Assistants API vs. `@openai/codex-sdk`) is settled —
**we migrated to `@openai/codex-sdk`.** `electron/agent/codex.ts` now drives the
SDK (`Codex.startThread` / `resumeThread`, `thread.runStreamed`) instead of the
`openai` `beta.threads` Assistants API.

This **reshapes the remaining workstreams** above, because the SDK is not an
HTTP client — it spawns the Codex CLI binary and runs Codex as a self-driving
agent that executes its own tools inside its own sandbox:

- **The `requires_action` loop is moot.** Codex executes shell/file/MCP tools
  itself; we no longer route tool calls through `runGatedTool`. Instead we
  configure Codex's `sandboxMode` + `approvalPolicy` (`resolveSandboxPolicy`)
  and reflect the streamed `item.*` events (`command_execution`, `file_change`,
  `mcp_tool_call`, …) onto the timeline + trace transcript.
- **#127 / #128 are reframed** around mapping AIchemist's approval/trust model
  onto Codex's sandbox/approval policy. Surfacing Codex's interactive
  `on-request` approvals through our approval UI is the remaining hard part —
  the non-interactive `codex exec` transport can't do interactive callbacks, so
  it needs the app-server JSON-RPC protocol (still open).
- **#131 (traces) is largely done** by the migration: `codex.ts` writes a native
  transcript and `trace-handlers.ts` routes `codex` to the native branch.
- **Runtime dependency:** the SDK resolves the `codex` binary from the bundled
  `@openai/codex-<platform>` package (or `CODEX_CLI_PATH`); that binary must be
  packaged with the app.

## Shared modules to reuse (do not re-implement)

| Concern | Module |
|---|---|
| Approval gate + tool_call persistence + timeline | `electron/agent/tool-gate.ts` (`runGatedTool`, `GatedToolContext`) |
| Built-in tool implementations | `electron/agent/tool-impls.ts` |
| Managed MCP loading / adapters | `electron/mcp/managed.ts` (`loadManagedMcpServers`) |
| Native transcript recorder | `electron/native-transcript.ts` (`createNativeTranscriptRecorder`) |
| Tool-round cap + truncation notice | `readMaxToolRounds()`, `emitToolRoundLimitNotice()` (`electron/agent/turn-emitter.ts`) |
| Trace dispatch | `electron/ipc/trace-handlers.ts` |
