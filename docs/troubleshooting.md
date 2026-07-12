# Troubleshooting

## A provider is greyed out in the new-session menu

Hover it — the tooltip states the reason. Common causes:

- **Anthropic: "invalid key"** — check `ANTHROPIC_API_KEY` in `~/.aichemist/.env` (or log in with the Claude CLI if you use Pro/Max). A 404-style message usually means a wrong `ANTHROPIC_BASE_URL`.
- **Copilot** — `GITHUB_TOKEN` missing, expired, or the account has no Copilot access.
- **Ollama** — the daemon isn't running, or (if the message says so) no models are installed: `ollama pull <model>`.
- **OpenAI-compatible** — no endpoints configured yet (add one in **Settings → Providers**), or none of the configured endpoints answered `/models`.
- **"Disabled in settings"** — re-enable the provider in **Settings → Providers**.

Availability is re-checked when the app window regains focus, so fixing the underlying issue (starting Ollama, adding a key + restarting) clears the state on its own.

## Changes to `~/.aichemist/.env` don't take effect

The file is read once at startup — restart the app.

## The app won't start after an update (native module errors)

Errors mentioning `better-sqlite3` or `node-pty` after an Electron upgrade mean the native modules need rebuilding:

```bash
bun run rebuild
```

## The agent seems stuck

Check the timeline for a pending **approval dialog** or **question card** — the agent is waiting for you. Approvals and questions time out after a few minutes if unanswered.

## The Traces tab is empty

Traces exist only after the session's first completed turn. If the session has run turns and the tab is still empty, the provider's transcript file may have been cleaned up outside the app.

## An Ollama / local model stops mid-task with a truncation notice

Self-driven providers cap the number of tool-call rounds per turn (default 8) to prevent runaway loops. Raise **max tool rounds** in **Settings → Defaults** (takes effect on the next message) and ask the agent to continue.

## A skill or MCP toggle didn't seem to apply

Both apply from the **next message**, not retroactively to a running turn. For Copilot sessions, changing MCP servers or the selected agent starts a fresh underlying SDK conversation on the next turn (your visible chat history is unaffected).

## A scheduled workflow didn't run

- Schedules are **forward-only** — firings missed while the app was fully quit are not replayed. Keep the app (or its tray icon) running.
- Check the workflow is **enabled** and its cron expression is valid (the editor previews the next run time).
- A `reuse`-session workflow whose session was busy records the firing as **skipped** — see the run history.

## An autonomous workflow's tools were "denied automatically"

That's the guardrail working: autonomous runs never prompt, so any tool that isn't pre-trusted (project allowlist or approval mode "None") is denied. Trust the tools it needs in the project's approval settings, or switch the workflow to interactive.
