# Scheduled workflows

Date: 2026-06-21

## Problem

Every agent turn today is initiated by a human: the renderer calls `AGENT_SEND`,
which runs `executeAgentTurn` → `runAgentTurn`. There is no way to define a
repeatable task ("triage new bug issues every morning", "run the test suite
nightly and fix what broke") and have the app run it on its own.

Skills look like a tempting building block, but they are the wrong primitive for
the *trigger*. A skill (`SKILL.md`) is passive context — `buildSkillsContext()`
injects its body into the system prompt. It shapes *how* an agent responds to a
prompt; it never *initiates* a turn and carries no notion of a schedule. A
workflow is the opposite: something that fires on its own and *starts* a turn. A
workflow can *reference* an agent and skills, but it is its own first-class
entity.

The execution unit we need already exists. A workflow run is `runAgentTurn(...)`
invoked by a scheduler instead of by a renderer IPC call. The bulk of the work
is plumbing and making unattended execution safe — not new agent machinery.

## Goals

- A first-class **Workflow** entity: a saved task (prompt + agent + skills +
  provider/model) bound to a project, fired on a cron schedule and/or manually.
- A main-process **scheduler** that arms enabled workflows on boot and on edit.
- Make the turn entry point callable **headlessly** (no renderer round-trip).
- Make unattended runs **safe**: never hang on an approval or `ask_user`, and
  never touch the filesystem/shell without an explicit per-workflow trust opt-in.
- **Run history** and completion notifications so the user can see what happened
  while they were away.

## Non-goals

- Firing workflows while the app is fully closed (OS-level launchd/Task
  Scheduler/cron driving a headless Electron mode). First release is
  **app-open** only, optionally surviving window close via a tray icon.
- Event-driven triggers (GitHub webhook, file-watch). Cron + manual only for now;
  the trigger model is designed to admit them later.
- Multi-step DAGs / branching workflows. A workflow is a single agent task; the
  agent's own tool loop provides the "steps".
- Cross-project workflows. A workflow targets exactly one project.

## Design

### Why a new entity, not a skill

| Concern | Skill | Workflow |
|---|---|---|
| Purpose | Passive guidance injected into a prompt | Active task that starts a turn |
| Trigger | None | cron + manual |
| Lifecycle | Lives inside one turn | Persists, runs many times, has run history |
| References | — | names an agent + skills + provider/model |

Skills remain what they are. A workflow *selects* skills (and an agent) to
activate for its run, exactly as a session does today.

### Workflow data

New `workflows` table (append a migration to the `MIGRATIONS` array in
`electron/db.ts` — append-only; never edit an existing entry):

| Column | Purpose |
|---|---|
| `id TEXT PRIMARY KEY` | uuid |
| `project_id TEXT NOT NULL` | FK → `projects` (cascade delete) |
| `name TEXT NOT NULL` | display name |
| `prompt TEXT NOT NULL` | the task sent as the turn prompt |
| `provider TEXT` | provider lock for runs (nullable → project default) |
| `model TEXT` | model override (nullable → project/provider default) |
| `agent TEXT` | selected agent name (nullable) |
| `skills TEXT` | JSON array of skill names (nullable) |
| `cron TEXT` | cron expression (nullable → manual-only workflow) |
| `enabled INTEGER NOT NULL DEFAULT 1` | scheduler arms only enabled rows |
| `session_strategy TEXT NOT NULL` | `"fresh"` (new session per run) or `"reuse"` (one long-lived session) |
| `reuse_session_id TEXT` | the session reused when strategy = `reuse` (nullable) |
| `autonomy TEXT NOT NULL` | `"interactive"` / `"autonomous"` — see Unattended execution |
| `created_at TEXT NOT NULL` | iso |
| `last_run_at TEXT` | iso (nullable) |

New `workflow_runs` table for history:

| Column | Purpose |
|---|---|
| `id TEXT PRIMARY KEY` | uuid |
| `workflow_id TEXT NOT NULL` | FK → `workflows` (cascade delete) |
| `session_id TEXT` | the session the run executed in |
| `status TEXT NOT NULL` | `running` / `success` / `error` / `skipped` |
| `trigger TEXT NOT NULL` | `cron` / `manual` |
| `started_at TEXT NOT NULL` | iso |
| `ended_at TEXT` | iso (nullable) |
| `error TEXT` | message when status = `error` (nullable) |

CRUD lives in a new `electron/workflows.ts`, mirroring `electron/sessions.ts`.

### Session strategy

A workflow run must execute *in a session*, since the session is the unit that
owns messages, provider state, traces, and the turn queue.

- **`fresh`** — create a new session per run (`createSession`), titled after the
  workflow + timestamp. Clean context every time; run history is one session per
  run. Default and recommended for most workflows.
- **`reuse`** — keep one long-lived session (`reuse_session_id`) so the agent
  accumulates context across runs. Created lazily on first run.

Either way the run is provider-locked at the session, consistent with the
existing per-session provider lock.

### Headless turn entry point

Today the turn lifecycle is trapped inside the IPC handler: `executeAgentTurn`
is private to `electron/ipc/agent-handlers.ts` and the path assumes a live
`webContents`. Extract the turn-execution core into a shared module callable by
both the handler and the scheduler.

- Move `executeAgentTurn` (and the queue helpers it needs) into a module that
  takes `getMainWindow()` and tolerates a `null` window. The queue already
  models the null-window case in `drainNextQueued`, so the pattern exists — a
  scheduled run with no window persists its results to SQLite and emits nothing
  to a renderer that isn't there.
- The scheduler enqueues through the **same per-session queue / `activeTurns`**
  machinery so a scheduled run never collides with a user-driven turn on the
  same session. A workflow run is just another `QueuedTurn`.

### Scheduler

New `electron/agent/workflow-scheduler.ts`, started from `app.whenReady()` in
`electron/main.ts` after `registerAllHandlers()`.

- Use a cron library rather than hand-rolling parsing or a naive `setInterval`.
  Recommend **`croner`** (zero-dependency, TS-native, timezone/DST aware, gives
  "next run" directly for the UI preview).
- On boot: load enabled workflows with a `cron`, arm one job each.
- On create/update/enable/disable/delete: re-arm (stop the old job, start a new
  one) so saved changes take effect without a restart.
- On fire: resolve/create the target session per `session_strategy`, write a
  `workflow_runs` row (`running`), then submit the turn through the shared
  headless entry point. Update the run row to `success`/`error` in a `finally`.
- **Overlap policy:** if the workflow's session is busy (or the previous run
  hasn't finished), record the fire as `skipped` rather than stacking runs.
- **Missed runs:** `croner` fires forward only; on boot we do not replay missed
  occurrences. (Catch-up is a possible later option, gated behind a per-workflow
  flag.)

### Unattended execution (the hard part)

Scheduled runs happen with nobody watching, so the two interactive pause points
must be neutralized:

1. **Approvals.** `requestApproval()` emits `SESSION_APPROVAL_REQUIRED` to the
   renderer and waits up to 5 minutes before auto-denying. Unattended, every
   gated `write_file` / `execute_bash` would stall 5 minutes then fail. The
   workflow's `autonomy` field drives an effective approval policy for the run:
   - **`interactive`** — the run still pauses for approval (only useful for
     `reuse` workflows a human babysits, or manual "Run now" with the app
     focused). Honest default for anything that mutates state.
   - **`autonomous`** — the run resolves approvals from the project allowlist /
     an explicit per-workflow trust set without prompting. The mechanism already
     exists (`isProjectAllowed` + `approval_mode: "none"` in
     `electron/agent/approval.ts`); the workflow makes opting into it a
     deliberate, scoped, security-relevant choice rather than a global toggle.
2. **`ask_user`.** A scheduled turn must never block on a question. In
   non-interactive mode, `ask_user` (and any un-allowlisted approval under
   `autonomous`) resolves immediately to abort/deny, ending the turn with a
   recorded reason instead of hanging.

Thread a `nonInteractive: boolean` (and the resolved approval policy) through the
turn params so the providers' approval/question paths take the immediate-resolve
branch. This is additive — interactive user turns keep today's behavior.

### Results and notification

- Each run persists into its session, so the transcript is visible when the user
  returns (fresh strategy → one session per run; reuse → appended).
- On completion, fire an Electron `Notification` (success/error summary) and push
  a `WORKFLOW_RUN_UPDATED` event so an open renderer can live-update.
- The `workflow_runs` table backs a run-history view (status, timing, error).

### IPC surface

Follow the CLAUDE.md checklist for each (channel constant in `ipc-channels.ts` →
entry in `ipc-contract.ts` → handler module → `preload.ts` → `src/lib/ipc.ts`):

| Channel | Purpose |
|---|---|
| `WORKFLOW_LIST` | list workflows (optionally by project) |
| `WORKFLOW_UPSERT` | create / update (validated; re-arms scheduler) |
| `WORKFLOW_DELETE` | delete (cancels its job, cascades runs) |
| `WORKFLOW_SET_ENABLED` | enable / disable (re-arms) |
| `WORKFLOW_RUN_NOW` | manual trigger (`trigger: "manual"`) |
| `WORKFLOW_LIST_RUNS` | run history for a workflow |
| `WORKFLOW_RUN_UPDATED` | main → renderer push on run state change |

Handlers go in a new `electron/ipc/workflow-handlers.ts`, registered from
`registerAllHandlers()`. `WORKFLOW_UPSERT` gets a zod validator in
`electron/ipc/validators.ts` (it's a high-impact mutation that can schedule
autonomous filesystem/shell work).

### Renderer surface

- A **Workflows** view to list/create/edit workflows: name, prompt, project,
  provider/model, agent + skills pickers (reuse the existing pickers), cron
  expression with a human-readable "next run" preview, session strategy, and the
  autonomy choice with a clear warning on `autonomous`.
- **Run now** button and a **run-history** panel (status, timing, link into the
  run's session).
- Surface `autonomy: "autonomous"` prominently — it is the app acting on the
  filesystem/shell with no human in the loop.

### App-open vs. true background

An in-process scheduler only fires while the app is running. To cover "I closed
the window but want workflows to keep firing", add a tray icon and stop quitting
on `window-all-closed` (today `electron/main.ts` quits on non-darwin) when at
least one enabled scheduled workflow exists. Firing while the app is *fully
closed* is explicitly out of scope for this release (see Non-goals).

## Error handling

- Invalid cron expression → reject at `WORKFLOW_UPSERT` (validate via `croner`),
  surface in the editor; never arm a job from an unparseable expression.
- A run that throws is recorded `error` with the message; the scheduler keeps the
  job armed for the next occurrence (one failure doesn't disable the workflow).
- Window/notification absence is non-fatal — runs persist regardless, mirroring
  the existing fail-safe null-window handling in the queue.
- Deleting a project cascades to its workflows; deleting a workflow cancels its
  armed job before removing rows.

## Testing

- `workflows.ts` CRUD + the appended migration (fresh DB and upgrade path).
- Scheduler: arm on boot, re-arm on edit/enable/disable, cancel on delete,
  overlap → `skipped`, cron parse failure rejected.
- Headless turn entry: runs with a null window, persists results, never emits to
  an absent renderer.
- Unattended safety: `nonInteractive` makes `ask_user` and un-allowlisted
  approvals resolve immediately; `autonomous` honors the project/workflow
  allowlist; `interactive` still pauses.
- Run history rows transition `running → success/error/skipped` with timing.

## Phasing

1. `workflows` / `workflow_runs` tables + `electron/workflows.ts`; extract the
   headless turn entry point.
2. Non-interactive turn mode + per-workflow autonomy/trust policy — land this
   *before* any real scheduling.
3. `croner` scheduler + `WORKFLOW_RUN_NOW` (manual trigger validates the full
   path with a human present).
4. Cron arming on boot/edit + run history + notifications.
5. Renderer Workflows view.
6. (Optional, later) tray / survive-window-close; event-driven triggers.
