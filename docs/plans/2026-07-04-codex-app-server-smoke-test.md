# Smoke test: Codex app-server interactive approvals (#128)

Manual, human-in-the-loop validation of the `codex app-server` transport and the
interactive approval bridge (PRs #146/#148/#150/#152 + the bundled-binary
resolution #153). The unit suite mocks the JSON-RPC peer, so this checklist
covers the one thing it can't: driving the **real** binary end-to-end and
confirming the doc-derived protocol assumptions (item shapes, the
`approved`/`denied` decision enum, `thread/resume`, usage) hold against
`codex-cli 0.142.3`.

Run it after any change to `codex.ts`, `codex-app-server.ts`,
`codex-approval-bridge.ts`, `codex-item-mapper.ts`, or `codex-binary.ts`, and
before cutting a release that ships Codex.

---

## Preconditions

- [ ] `bun run build` (or `bun run dev`) succeeds; app launches.
- [ ] `~/.aichemist/.env` has a working `OPENAI_API_KEY` (Codex probe shows the
      provider as available in the new-session picker).
- [ ] The bundled binary resolves: `node_modules/@openai/codex-<platform>/vendor/<triple>/bin/codex --version` prints `codex-cli 0.142.3`.
- [ ] A throwaway git project is open (or `skipGitRepoCheck` covers a non-repo) with
      a couple of files to edit.
- [ ] DevTools / terminal console visible so you can watch main-process logs.

## How to tell which transport is running

The decisive **behavioral** tell: an interactive turn that proposes a shell
command **pops the approval dialog**. The exec transport can't do interactive
callbacks (it uses `on-failure`), so if you see an approval prompt for a command,
you're on the app-server. Corroborating signals:

- **Log:** the fallback prints `"[codex] app-server unavailable, falling back to exec transport: …"`. Its **absence** on an interactive turn = app-server engaged.
- **Process:** while a turn runs, `ps aux | grep "[c]odex app-server"` shows a child process.

---

## Scenarios

### 1. App-server engages for an interactive turn
- [ ] New Codex session (provider-locked to Codex), a window focused (interactive).
- [ ] Prompt something that needs a shell command, e.g. *"run `ls` in the project root and tell me what's here."*
- [ ] **Expected:** an approval dialog appears for the command; no fallback warning in the log; `codex app-server` child process visible.

### 2. Command approval → **Allow**
- [ ] From #1, click **Allow** (once).
- [ ] **Expected:** the command runs; its output streams into the timeline as a tool call + result; Codex continues and answers. Trace shows the command item.

### 3. Command approval → **Deny**
- [ ] Prompt another command (e.g. *"delete the file `scratch.txt` with rm."*).
- [ ] Click **Deny**.
- [ ] **Expected:** the command does **not** run; Codex reports it was denied / picks another path; no file was deleted.

### 4. Trusted command does not re-prompt
- [ ] If the approval dialog offers **Allow for session** (or pre-add `execute_bash` to the project allowlist in settings), approve once.
- [ ] Prompt the **same** command again.
- [ ] **Expected:** it runs with **no** second prompt (session/project allowlist short-circuits the gate).

### 5. File edit → Changes panel + parity
- [ ] Prompt an in-workspace edit, e.g. *"add a comment to the top of README.md."*
- [ ] Approve any write/permission prompt if shown.
- [ ] **Expected:** the edit lands on disk; the **Changes** panel shows the file (write op); the timeline shows a `file_change` tool item. A `node_modules/` or `.git/` path (if any) is **not** shown in Changes.

### 6. Filesystem permission request (if triggered)
- [ ] Try to make Codex write somewhere that triggers `item/permissions/requestApproval` (e.g. a path outside the workspace root).
- [ ] Test both: **Deny** → write blocked; **Allow** → the requested paths are granted and the write proceeds.
- [ ] **Expected (v1 limitation):** allow grants the **full** requested path set, deny grants none — there is no per-path selection UI yet.

### 7. Multi-turn context (thread resume)
- [ ] In the same session, send a second prompt that depends on the first (e.g. *"now do the same for the other file we discussed"*).
- [ ] **Expected:** Codex remembers prior context — the per-turn process resumed the persisted thread (`thread/resume`). Log shows no "new thread" churn; behavior is continuous.

### 8. Managed MCP tool call
- [ ] Configure at least one AIchemist-managed MCP server (Settings → MCP Servers) and prompt Codex to use it.
- [ ] **Expected:** Codex calls the MCP tool; it surfaces as an `mcp_tool_call` item (`server.tool`) on the timeline + trace. Toggling the server off for the session removes it next turn.

### 9. Traces tab
- [ ] Open **Traces** for the session after a turn.
- [ ] **Expected:** the codex transcript renders (turns, command/file/mcp tool spans, reasoning, usage) with no errors.

### 10. Usage / token counts
- [ ] After a turn, check the usage readout.
- [ ] **Expected:** non-zero input/output token counts (cache-read mapped where present). *(If counts are zero but everything else works, note it — the app-server usage field names are best-effort and may need a tweak; not a blocker.)*

### 11. Graceful fallback to exec
- [ ] Set `CODEX_CLI_PATH=/does/not/exist` in `~/.aichemist/.env`, restart, run an interactive turn.
- [ ] **Expected:** the log shows the fallback warning; the turn **still completes** on exec (degraded: no interactive approval prompt, `on-failure` policy). Unset `CODEX_CLI_PATH` afterward.

### 12. Non-interactive paths unaffected
- [ ] **PR-draft / noTools:** trigger a text-only generation (e.g. PR draft) — runs on exec, read-only, no prompts, not recorded to traces.
- [ ] **Autonomous workflow:** run a workflow with `autonomy: autonomous` (or with no window) — runs on exec, `never` approval policy, no hang waiting on a prompt.
- [ ] **Expected:** both behave exactly as before this work.

### 13. Process hygiene
- [ ] After several turns and closing the session/app, `ps aux | grep "[c]odex app-server"` shows **no** orphaned processes.
- [ ] **Expected:** each turn's app-server process is torn down (`client.close()` on turn end / connection close).

---

## Known limitations (expected, not bugs)

- Filesystem permission grants are all-or-nothing (no partial-path picker) — v1.
- Agent-message streaming is whole-message chunks, not token deltas (the app-server
  exposes `item/agentMessage/delta`; wiring it is a follow-up).
- Bundled-binary packaging in a signed/installed build is the same requirement as
  the exec path (the binary must ship with the app).

## Result

| Date | Version | Platform | Pass/Fail | Notes |
|---|---|---|---|---|
|  |  |  |  |  |

Log any mismatch between observed behavior and the assumptions above (especially
the decision enum in #2/#3, item rendering in #5/#8, and resume in #7) as a
follow-up issue — those are the doc-derived assumptions this test exists to catch.
