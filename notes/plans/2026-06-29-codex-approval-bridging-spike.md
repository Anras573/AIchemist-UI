# Spike: Codex interactive approval bridging (#128)

Surface Codex's interactive **on-request** approvals through AIchemist's existing
approval UI, so an interactive Codex session prompts the user before running a
command / writing files — at parity with the gate every other provider uses.

Issue: **#128** (parity epic #116). This is a design spike — no production code.

---

## TL;DR / recommendation

- The `@openai/codex-sdk` we use today drives **`codex exec`** — a **one-shot,
  non-interactive** transport that **cannot** surface approval callbacks. That's
  why interactive Codex turns currently fall back to `approvalPolicy: "on-failure"`
  (see `resolveSandboxPolicy` in `electron/agent/codex.ts`) and never actually
  prompt.
- To get interactive approvals we must drive a **different Codex transport** that
  issues **server→client approval requests**. The bundled binary
  (`codex-cli 0.142.3`) exposes two candidates: **`codex app-server`**
  (experimental, rich) and **`codex mcp-server`** (stdio, established). Neither is
  wrapped by the TS SDK — we implement the JSON-RPC client ourselves.
- **Recommended approach:** a **per-turn transport switch**. Keep the current
  `codex exec` path for **autonomous / non-interactive** turns (they run
  `approvalPolicy: "never"` — no approvals needed, zero risk). Add a new
  **app-server (or mcp-server) JSON-RPC transport** used only for **interactive**
  turns, mapping Codex's approval requests onto the existing
  `requestApproval` → `SESSION_APPROVAL_REQUIRED` → `resolveApproval` gate. This
  isolates the new, more complex transport to the path that needs it and leaves
  today's behavior untouched for everything else.
- **Effort:** medium-large — a new stdio JSON-RPC transport layer is the bulk of
  the work. Phase it (see Phasing).

---

## Current state

`electron/agent/codex.ts` uses `@openai/codex-sdk` (`Codex.startThread` /
`thread.runStreamed`), which spawns `codex exec --experimental-json`. `exec` is
non-interactive: it cannot pause to ask the client for approval, so:

- `resolveSandboxPolicy()` maps `noTools` → `read-only`/`never`,
  `nonInteractive` (autonomous) → `workspace-write`/`never`, and **interactive →
  `workspace-write`/`on-failure`** — a pragmatic stand-in that lets work proceed
  without hanging, but never routes through AIchemist's approval UI.
- Managed MCP (#127), traces (#131), workflows (#126), skills/agent/memory (#124)
  are all done; **interactive approval is the one remaining parity gap.**

AIchemist's gate (the target to bridge onto), in `electron/agent/approval.ts`:

```
requestApproval(webContents, sessionId, toolName, input, { nonInteractive })
  → emits SESSION_APPROVAL_REQUIRED → approval dialog → resolveApproval(id, bool)
  → resolves Promise<boolean>
```

Plus `requiresApproval()` (session allowlist → project allowlist → category
rules) and `addToSessionAllowlist()` ("allow always" for the session).

---

## Why the SDK can't do it

`@openai/codex-sdk`'s `CodexExec` only runs `codex exec`. There is **no
app-server / mcp-server mode** in the TS SDK (the app-server is driven by Rust
crates: `codex-app-server-client`, `codex-app-server-test-client`). So bridging
approvals means **not** using the SDK for interactive turns — we spawn the Codex
binary in a server mode and speak JSON-RPC over stdio ourselves.

---

## Transport options (both confirmed in the bundled binary)

| Aspect | `codex app-server` | `codex mcp-server` |
|---|---|---|
| Status | `[experimental]` | established (documented MCP interface) |
| Model | Full thread/turn protocol; `thread/start`, `turn/start`, streamed `item/*` + `turn/*` notifications | Codex runs **as an MCP server**; client connects over stdio |
| Approval requests (server→client) | `item/commandExecution/requestApproval`, `item/permissions/requestApproval` | `execCommandApproval`, `applyPatchApproval` |
| Approval response | decision + optional `scope` (`"session"` / `"turn"`) + granted permission subset | `"allow"` / `"deny"` |
| Streaming | `item/agentMessage/delta` → **true token deltas** (better than exec's whole-message chunks) | item events |
| Risk | richer but experimental (protocol may shift) | simpler decision shape, more stable surface |

**Recommendation:** prototype against **`app-server`** (it's the forward-looking
protocol and gives token-delta streaming + structured permission scopes), but
keep `mcp-server` as a fallback if the experimental surface proves unstable. Both
require the same kind of stdio JSON-RPC client, so the transport abstraction can
target either.

### App-server lifecycle (sketch)

1. Spawn `codex app-server` (stdio), run the **initialize** handshake.
2. `thread/start { model, cwd, approvalPolicy: "on-request", sandbox, config: { mcp_servers } }`
   → `threadId` (persist in `provider_state.codex`, reuse existing slice).
3. `turn/start { threadId, input }` → stream `turn/started`, `item/started`,
   `item/agentMessage/delta`, `item/completed`, `turn/completed`.
4. **On a server→client approval request**, suspend, ask the user, reply with the
   decision (below).
5. `turn/completed` → usage; graceful shutdown / keep the process for the session.

---

## Mapping Codex approvals → AIchemist's gate

The bridge handler receives a Codex approval request and resolves it through the
**existing** gate — no new approval UI for command approvals:

- **`item/commandExecution/requestApproval`** (command, cwd, optional
  `additionalPermissions`):
  1. Call `requiresApproval(sessionId, config, "shell", "execute_bash",
     { command })` (it fingerprints internally via `computeFingerprint`). It returns **`false` when the call is already
     trusted** (session/project allowlist) — in that case reply **allow** with no
     prompt; a `true` return means approval is required, so continue to step 2.
  2. Otherwise `await requestApproval(webContents, sessionId, "execute_bash",
     { command }, { nonInteractive })` → `boolean`.
  3. Map: `false` → `deny`; `true` → `allow` (scope `turn`). An **"allow for
     session"** affordance maps to `scope: "session"` **and**
     `addToSessionAllowlist(...)` so subsequent identical calls don't re-prompt.
- **`item/permissions/requestApproval`** (filesystem write paths): the request is
  richer (a set of paths + a grantable subset) than our boolean dialog. **v1:**
  treat it as a single allow/deny — on allow, grant the **full requested subset**;
  on deny, grant none. A later iteration can extend the approval payload/UI to
  pick a subset (the protocol supports partial grants + `scope`).

**Non-interactive safety:** interactive turns are exactly the ones with a window
attached, so `requestApproval`'s `nonInteractive` auto-deny branch is never hit
here; autonomous/headless turns keep using `exec` with `approvalPolicy: "never"`
and never reach this transport. The 5-minute approval timeout already applies.

**Reuse, don't reinvent:** `SESSION_APPROVAL_REQUIRED`, `resolveApproval`, the
approval dialog, the allowlists, and `cancelSessionApprovals` (on session delete)
all work unchanged — Codex command approvals slot into the same machinery as
Claude/Copilot/Ollama tool approvals.

---

## Coexistence & event-mapping reuse

- **Transport switch** lives in `codexProvider.run()`: choose `exec` (current SDK
  path) when `noTools || nonInteractive`; choose the app-server transport for
  interactive turns. `resolveSandboxPolicy` interactive case becomes
  `workspace-write` + **`on-request`** (instead of `on-failure`) on the
  app-server path.
- **Event mapping is shared.** The app-server `item/*` payloads are the same
  item shapes (`agent_message`, `command_execution`, `file_change`,
  `mcp_tool_call`, `web_search`, `reasoning`) the exec path already maps to the
  `TurnEmitter` + native transcript. Factor the current `item.completed` handling
  in `codex.ts` into a shared mapper both transports call. **Bonus:**
  `item/agentMessage/delta` gives real token streaming, improving the interactive
  UX over exec's whole-message chunks.
- **Managed MCP** (#127) carries over: pass the same `config.mcp_servers` in
  `thread/start`.

---

## Phasing

- **Phase 1 (this issue's core):** stdio JSON-RPC transport for `app-server`;
  `thread/start` + `turn/start` + item streaming; bridge
  `item/commandExecution/requestApproval` to the existing gate (allow/deny +
  session-allow). Interactive turns only; `exec` unchanged for the rest. Shared
  item→emitter mapper. Unit tests with a mock app-server (inject a fake JSON-RPC
  peer, like `_setCodexFactoryForTests` does for the SDK).
- **Phase 2:** `item/permissions/requestApproval` with subset selection (small
  approval-payload/UI extension); token-delta streaming wired to `emitter.delta`;
  consider converging autonomous turns onto app-server too (with
  `approvalPolicy: "never"`) to retire the dual transport.

---

## Open questions / risks to validate in implementation

1. **Experimental protocol churn.** `app-server` is `[experimental]`; pin to the
   bundled `codex-cli` version and add a transport seam so swapping to
   `mcp-server` (allow/deny only) is cheap if the surface shifts.
2. **JSON-RPC framing + lifecycle.** We must implement stdio message framing,
   the initialize handshake, request/response id correlation, **and** inbound
   server→client request handling — there's no TS helper. Reference the Rust
   `codex-app-server-client` crate for the handshake/lifecycle contract.
3. **Process lifecycle.** `app-server` is long-running (vs `exec`'s one-shot):
   decide per-session vs shared process, cleanup on session close, and crash
   recovery (fall back to `exec`/`on-failure` if the app-server can't start).
4. **Thread resume.** Confirm the app-server thread-resume call and that the
   `provider_state.codex.threadId` persisted by the exec path is compatible (or
   keep separate ids per transport).
5. **Permission-approval UX.** The boolean dialog can't express partial path
   grants; Phase 1 does grant-all-or-deny, Phase 2 extends the payload/UI.
6. **Packaging.** Same bundled-binary requirement as #140 — the
   `@openai/codex-<platform>` binary (which includes `app-server`) must ship with
   the app.

---

## References

- Approval gate: `electron/agent/approval.ts` (`requestApproval`,
  `resolveApproval`, `requiresApproval`, `addToSessionAllowlist`).
- Current Codex provider: `electron/agent/codex.ts` (`resolveSandboxPolicy`,
  `describeToolItem`, the `item.completed` mapping to reuse).
- Managed MCP for `thread/start`: `toCodexMcpServers` (`electron/mcp/managed.ts`).
- Codex protocol: `codex-rs/app-server/README.md` (turn/start, item/*,
  `item/commandExecution/requestApproval`, `item/permissions/requestApproval`),
  `codex-rs/docs/codex_mcp_interface.md` (`execCommandApproval`,
  `applyPatchApproval`), `codex-rs/app-server-client` (lifecycle).
- Prior context: `notes/plans/2026-06-28-codex-parity-plan.md`.
