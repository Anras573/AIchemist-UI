# Workflows

Workflows are saved, repeatable agent tasks: "triage new bug issues every morning", "run the test suite nightly and fix what broke", "summarize changes whenever this folder is touched". Open the Workflows view from the **calendar-clock** button in the project sidebar.

## Creating a workflow

A workflow bundles everything needed to run a turn unattended:

| Field | Meaning |
|---|---|
| **Name & prompt** | What the agent is asked to do on each run. |
| **Project** | The folder the run works in. |
| **Provider / model / agent / skills** | Same options as an interactive session. |
| **Triggers** | A cron schedule, a watched path, both, or neither (manual-only). |
| **Session strategy** | `fresh` — a brand-new session per run; `reuse` — all runs share one ongoing session. |
| **Autonomy** | `interactive` or `autonomous` (see below). |
| **Enabled** | Disable to keep the workflow without it firing. |

## Triggers

- **Cron** — standard cron expressions, DST-aware. The editor shows a live "next run" preview and rejects invalid expressions.
- **File watch** — pick a folder (recursive); rapid bursts of changes are coalesced into a single run. You can save a workflow whose watched path doesn't exist yet, but the watcher only attaches when the workflow is armed — at app launch, or when the workflow is saved or re-enabled. If the path is missing (or unwatchable) at that moment, the file trigger stays inactive until the workflow is saved again or the app restarts.
- **Manual** — every workflow has a **Run now** button regardless of triggers.

Scheduling is **forward-only**: runs missed while the app was closed are not replayed.

## Autonomy — the important choice

- **Interactive** — the run pauses for tool approvals like a normal session. Only useful when you're around (or for a reused session you're watching); if no window is open, prompts can't be answered and gated tools are **denied automatically** rather than hanging.
- **Autonomous** — the run never prompts. Tools you've pre-trusted (project allowlist, or approval mode "None") execute; anything else is denied immediately and noted in the transcript as "denied automatically — not in allowlist".

The editor shows a prominent warning for autonomous mode — it is the app acting on your filesystem and shell with no human in the loop. Grant it only the tools you're comfortable with.

## Runs and history

Each firing records a run: status (**success** / **error** / **skipped**), what triggered it, timing, and a link to the session that ran it — so you can read the full transcript of any run.

- A trigger firing while the workflow's reused session is busy records a **skipped** run instead of stacking turns. (`fresh` workflows never skip.)
- A finished run fires an OS notification.
- A failing run never disarms the schedule — the next trigger still fires.

## Running with the window closed

While at least one enabled workflow has a trigger, AIchemist keeps a **system tray icon**. Closing the last window then leaves the app alive in the tray so schedules keep firing; use the tray menu to reopen the window or quit. With no scheduled workflows, closing the window quits as usual (on Windows/Linux). Workflows do not fire while the app is fully quit.
