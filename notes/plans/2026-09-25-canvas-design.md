# Canvases — full-stack work surfaces shared by the agent and the user

Date: 2026-09-25

## Problem

Everything an agent produces in AIchemist today is either chat text in the
timeline or a file on disk (surfaced through the Changes / Files panels). For a
lot of work, chat is the wrong UI: "it's not at all obvious what to do when
your only method of interaction is a textarea." There is no structured, living
surface that the agent and the user both operate on — a board the user
reorders and the agent then acts on, a database browser, a package manager, a
blog-post editor, a game.

GitHub's Copilot app ships this as **canvases**. Sources:

- Docs — <https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions>
- Blog — <https://github.blog/ai-and-ml/github-copilot/when-chat-is-the-wrong-ui/>

What those sources establish:

- A canvas is "a little full-stack application that runs inside of the GitHub
  Copilot app with no browser chrome", opened in the right side panel.
- It is **full-stack, not just a web page**: canvases "can call third-party
  APIs, yes, but they can also execute code locally on your machine."
- It is **bidirectional**: "the agent can communicate with the server part of
  that app and the server can communicate back." The agent calls methods the
  extension declares (kanban example: `get_board`, `add_card`, `move_card`);
  the user edits the same surface through its UI controls.
- It is **authored by the agent**: "Building a canvas is as simple as asking
  for it … the agent knows what a canvas is" (via a `/create-canvas` skill).
- It is **packaged as a folder** — `package.json` + an entry file
  (`extension.mjs`) + optional JSON state — under `.github/extensions/`
  (team, committed) or `~/.copilot/extensions/` (personal).
- Showcased canvases: Connect 4 against the agent; a winget (Windows Package
  Manager) UI; a SQLite browser with IntelliSense; a Jekyll post editor; an
  "agent loop" workflow canvas that uses GitHub issues as its state store.

Neither source documents the extension API, the rendering technology, the
agent↔server protocol, or any sandbox model. This document designs an
AIchemist-native equivalent with the same capabilities, not a
wire-compatible clone.

The showcase examples fix the capability bar: winget and SQLite need local
process / file access, the issues canvas needs network, Connect 4 needs the
canvas to **start** an agent turn ("your move"). A purely declarative or
browser-only canvas cannot do any of them, so a canvas must be able to run
real server-side code.

## Goals

- A first-class **Canvas**: a server module + a UI, rendered in the right
  panel, with agent-callable tools, able to run local code and reach the
  network.
- **Bidirectional**: the agent calls the canvas's tools; the canvas can push
  UI updates and can **send a message into the session** to start an agent
  turn.
- **One tool path for all five providers** (Claude, Copilot, Ollama,
  OpenAI-compatible, Codex), respecting the per-session provider lock.
- **Agent-authorable**: the agent knows canvases exist and can build one on
  request (`/create-canvas`), and the result hot-reloads into the panel.
- **Explicit trust**: canvas server code runs only after the user trusts it,
  isolated from the Electron main process and from the renderer's privileged
  bridge.

## Non-goals

- Wire compatibility with Copilot's `extension.mjs` API (undocumented). A
  best-effort importer is a later phase.
- A true security sandbox for canvas *server* code. Trusted server code runs
  with the user's privileges, the same trust level as a stdio MCP server in a
  project's `.mcp.json`. We isolate it for **stability** and to keep it away
  from AIchemist's own privileged surfaces, and we gate it behind **consent** —
  we don't pretend to contain it.
- Real-time multi-user collaboration. "Shared" means shared between one user
  and their agent.

## Design

### Concepts

| Term | Meaning |
|---|---|
| **Canvas definition** | A folder on disk (or a built-in): manifest + server module + UI assets. Reusable. |
| **Canvas instance** | A definition bound to a project with its own persisted state (e.g. "Release 2.4 board"). One definition can back many instances. |
| **Canvas host** | The running process for one instance: loads the server module, owns its state, serves its tools. |
| **Canvas tool** | An agent-callable method the server declares. |

### Definition format

```
<root>/<canvas-name>/
  canvas.json        # manifest (required)
  server.mjs         # server module (required)
  ui/index.html      # UI entry (required) + any assets under ui/
  package.json       # optional; dependencies installed on trust (see Lifecycle)
```

`canvas.json`:

```jsonc
{
  "name": "sqlite-browser",
  "description": "Browse and query a SQLite database",
  "version": 1,
  "server": "server.mjs",
  "ui": "ui/index.html",
  "attachByDefault": false,  // auto-attach to new sessions in this project
  "permissions": {           // declared intent — shown in the trust prompt,
    "fs": ["${project}"],    // NOT enforced in v1 (see "OS-level sandboxing")
    "network": ["api.github.com"],
    "exec": ["git"]
  }
}
```

Tools are declared in code, not in the manifest, because their handlers are
code. Discovery tiers (higher suppresses same-named lower, like skills):

| Tier | Path |
|---|---|
| Project | `<projectPath>/.agents/canvases/*/` |
| Global | `~/.aichemist/canvases/*/` |
| Built-in | shipped with the app (`kanban`, `checklist`, `markdown`) |

`.agents/` matches where project skills and Copilot agents already live. A
manifest failing zod validation is skipped with a logged reason and shown in
the settings hub; it never breaks discovery.

### Server SDK

`server.mjs` default-exports a definition built with a small SDK
(`@aichemist/canvas`, resolved by the host — no install needed):

```js
import { defineCanvas, z } from "@aichemist/canvas";

export default defineCanvas({
  initialState: { columns: { todo: [], doing: [], done: [] } },

  tools: {
    get_board: {
      description: "Return the whole board",
      input: z.object({}),
      handler: (_args, ctx) => ctx.state.get(),
    },
    move_card: {
      description: "Move a card to another column",
      input: z.object({ id: z.string(), to: z.enum(["todo", "doing", "done"]) }),
      approval: "none",                  // "none" | "ask" (default "ask")
      handler: ({ id, to }, ctx) => {
        ctx.state.update((s) => moveCard(s, id, to));
        return { ok: true };
      },
    },
  },

  // Messages from the UI (button clicks, drags, form submits).
  async onUiMessage(msg, ctx) {
    if (msg.type === "move") ctx.state.update((s) => moveCard(s, msg.id, msg.to));
    if (msg.type === "ask-agent") await ctx.agent.send(`Please triage card ${msg.id}`);
  },
});
```

The `ctx` object passed to every handler:

| API | Purpose |
|---|---|
| `ctx.state.get()` / `set(v)` / `update(fn)` | Persisted JSON state for this instance (SQLite-backed, see Data model). Every change bumps `revision` and pushes to the UI. |
| `ctx.ui.send(msg)` | Push an arbitrary message to the UI (beyond state sync — e.g. query results, progress). |
| `ctx.agent.send(text, opts?)` | Send a message into an attached session, starting (or queueing) an agent turn — the "server can communicate back" path. See below. |
| `ctx.project` | `{ id, path }` — the project the instance belongs to. |
| `ctx.log` | Structured logs, shown in the canvas's debug drawer. |

Everything else is plain Node: `child_process` for winget, `better-sqlite3`
or `node:sqlite` for the SQLite browser, `fetch` for the GitHub-issues canvas.
Canvases are free to keep state elsewhere (a `.db` file, GitHub issues) and
use `ctx.state` only for UI state.

### Runtime — canvas host process

Each **active** instance runs in its own Electron `utilityProcess`
(`utilityProcess.fork`), started by a `CanvasHostManager` in the main process.
All launching goes through a single `spawnCanvasHost()` seam so a sandboxed
launcher can replace it later without touching the rest (see "OS-level
sandboxing"):

- **Not the main process** — a crash, a hang, or a busy loop in canvas code
  can't take down AIchemist; a stuck host is killed and restarted.
- **No Electron privileges** — the host has no `BrowserWindow`, no IPC
  handlers, no access to `window.electronAPI`; it talks to main only over its
  own `MessagePort` using a narrow, zod-validated message set.
- `cwd` = project path; environment is AIchemist's env **minus** API keys
  (`ANTHROPIC_*`, `GITHUB_TOKEN`, `OPENAI_*`, …) — a canvas that needs a
  credential declares it and the user supplies it (later phase), rather than
  inheriting every provider key by default.

Lifecycle:

- **Start** when the instance is opened in the panel, or when a turn runs in a
  session it is attached to.
- **Idle stop** after N minutes (default 10) with no open panel and no running
  turn; state is persisted, so a restart is transparent.
- **Crash** → restart with exponential backoff (max 3 in 60 s), then an
  error state in the panel with logs and a "Restart" button.
- **Dev reload** — the definition folder is watched (same `fs.watch` +
  debounce approach as workflow file triggers); a change restarts the host and
  reloads the UI. This is what makes agent-authored canvases feel live.
- **Dependencies** — if `package.json` declares dependencies, `bun install`
  runs in the definition folder once, **after** the trust prompt, with output
  shown in the panel.

### Agent tools — one loopback MCP endpoint for all providers

Rather than adapting canvas tools per provider, the main process runs a single
**loopback streamable-HTTP MCP server** (`127.0.0.1`, random port, per-launch
bearer token). Each attached instance is exposed at
`/canvas/<canvasId>/session/<sessionId>/mcp` and injected into the turn as a
managed MCP server named `canvas-<slug>`:

| Provider | How it arrives |
|---|---|
| Claude | Added to `query({ mcpServers })` alongside managed servers (HTTP entry) |
| Copilot | Added to `SessionConfig.mcpServers` (HTTP). The attached-canvas set is folded into `provider_state.copilot.mcpFp`, so attach/detach forces a fresh `createSession` — `resumeSession` ignores new MCP servers |
| Codex | Added to `CodexOptions.config.mcp_servers` as `{ url, http_headers }`; re-read on every spawn, so no fingerprint |
| Ollama / OpenAI-compatible | Reached through `createManagedMcpBridge()` like any managed HTTP server |

All four adapters in `electron/mcp/managed.ts` already handle HTTP entries,
so this adds **no per-provider tool code** and Codex (which runs its own tool
loop and can only reach us over MCP) is covered on day one.

Requests arrive in main, which forwards `tools/list` / `tools/call` to the
instance's host over its `MessagePort`. Because the session id is in the path,
main can do the gating itself:

- **Approval** — Claude's `PreToolUse` hook passes every `mcp__*` tool
  through unexamined, so canvas tools can't rely on it. The loopback server
  calls `requiresApproval()` / `requestApproval()` itself (with the session's
  `nonInteractive` flag) for tools whose `approval` isn't `"none"`, so
  unattended workflow runs get the existing auto-deny for free.
- **Scoping** — a request for a canvas not attached to that session, or with a
  bad token, is rejected.

Only **attached** canvases are injected, so the tool list stays small. A short
system-prompt addendum (like `buildMemoryContext`) lists attached canvases and
their descriptions.

### UI — sandboxed iframe + message bridge

The UI renders in an `<iframe sandbox="allow-scripts">` inside `CanvasPanel`,
loaded from a custom protocol `aichemist-canvas://<canvasId>/<path>`
(`protocol.handle` in main), which serves only files under the definition's
`ui/` folder (`realpath` + prefix check).

- **No `allow-same-origin`** → opaque origin: no access to the host DOM,
  storage, or `window.electronAPI`. `webviewTag` stays disabled.
- **CSP** on served files: `default-src aichemist-canvas: 'unsafe-inline';
  connect-src 'none'`. The UI has **no network**; anything network- or
  system-bound goes through the server, where trust applies. (This is
  the reason for the "full-stack" split: the page stays inert, the server is
  where power lives.)
- **Bridge**: iframe ⇄ `postMessage` ⇄ `CanvasFrame` (checks
  `event.source === iframe.contentWindow`, zod-validates) ⇄ IPC ⇄ main ⇄
  `MessagePort` ⇄ host. A helper script `aichemist-canvas-client.js` (served by
  the protocol) gives authors `canvas.onState(fn)`, `canvas.onMessage(fn)`,
  `canvas.send(msg)` and handles the handshake + theme tokens (light/dark).
- **Built-in canvases** use the same SDK and the same iframe path — they
  dogfood the API, so the first phase proves what users will build on.

### Server → agent: starting turns

`ctx.agent.send(text, { sessionId? })` is how Connect 4 says "your move" and
how a workflow canvas kicks off the next step:

- Target: the given session, which must have the instance attached; if
  omitted and exactly one session is attached, that one; otherwise an error.
- Delivery: `enqueueTurn()` in `electron/ipc/agent-turn-queue.ts` — so a busy
  session queues rather than races, and the turn goes through the normal
  runner (status persistence, crash recovery, usage ledger).
- Visibility: the message is persisted as a user message tagged
  `source: "canvas:<name>"` and rendered with a canvas badge in the timeline,
  so the user can always see what the canvas asked the agent to do.
- Guardrails: rate-limited per instance (e.g. 1 in-flight + 5/minute), and
  refused while the session is `paused` awaiting approval. Turns started with
  no window attached are `nonInteractive` via the existing `executeAgentTurn`
  rule.

### Data model

Migration **v8** (append to `MIGRATIONS` in `electron/db.ts`):

```sql
CREATE TABLE canvases (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  definition   TEXT NOT NULL,       -- definition name, resolved via discovery
  title        TEXT NOT NULL,
  state        TEXT NOT NULL,       -- ctx.state JSON document
  revision     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE session_canvases (       -- canvases a session exposes to its agent
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  canvas_id    TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, canvas_id)
);
CREATE TABLE canvas_trust (           -- consent to run a definition's server code
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  definition   TEXT NOT NULL,
  content_hash TEXT NOT NULL,         -- hash of server + manifest + package.json
  trusted_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, definition)
);
```

Plus a nullable `source TEXT` column on `messages` for canvas-originated user
messages. Instances are project-scoped (a board outlives a session);
attachment to a session is explicit, like the per-session skill toggle.
`ctx.state` is capped (e.g. 1 MB) — larger data belongs in the canvas's own
storage.

### Trust model

Canvas server code is arbitrary code with the user's privileges. Consent:

| Tier | Default |
|---|---|
| Built-in | Trusted (app code) |
| Global (`~/.aichemist/canvases/`) | Trusted — the user put it there |
| Project (`.agents/canvases/`) | **Untrusted until approved**: first open shows the manifest, the server entry path and dependency list, and asks to trust. Stored in `canvas_trust` with a content hash; any change to the server, manifest or `package.json` (e.g. after `git pull`) re-prompts. |

Agent-authored canvases are written through `write_file` (approval-gated like
any file write) and still hit the trust prompt before first run — the
"approve the file write" step and the "run this code" step stay separate.
Until trusted, the panel can show the UI with the host stopped (read-only,
no tools), so the user can see what they're agreeing to run. The prompt also
lists the manifest's declared `permissions` (unenforced in v1).

### OS-level sandboxing (deferred)

`utilityProcess` isolation protects against crashes, not malicious code. An
OS-level sandbox around the host would add real containment. It is
**deliberately deferred**, but v1 is shaped so it can be added later.

**Pros**

- **Real containment.** Could stop a trusted canvas from reading `~/.ssh` or
  `~/.aichemist/.env`, writing outside the project, or reaching arbitrary
  hosts. Crash isolation does none of that.
- **Supply-chain defence.** `package.json` dependencies mean trusting a whole
  npm tree, not just the canvas author. A sandbox limits what a compromised
  transitive dependency can do.
- **Agent-authored canvases.** A canvas the agent writes can be shaped by
  prompt injection (a malicious issue or README). A sandbox bounds the damage
  even after the user clicks "trust".
- **Better trust UX.** Canvases could run sandboxed by default, with the prompt
  asking only about escalations ("wants network access to api.github.com").
  That is a clearer decision than "run this code?".
- **Precedent to reuse.** Codex sandboxes its own tools (Seatbelt / Landlock +
  seccomp), and Claude Code uses `sandbox-exec` + bubblewrap. Users already
  know the model, and the policies are there to learn from.
- **Enforced permissions.** The manifest's declared `permissions` become real.

**Cons**

- **Three unequal backends.** macOS `sandbox-exec` is deprecated and its policy
  language (SBPL) is undocumented, though still widely used. On Linux,
  bubblewrap may be absent, some distros block unprivileged user namespaces
  (e.g. Ubuntu 24.04's AppArmor restriction), and Landlock depends on the
  kernel version. On Windows, AppContainer / restricted tokens are awkward with
  Node (file ACLs, loopback exemption, capabilities).
- **Clashes with the showcase use cases.** winget triggers UAC elevation. The
  SQLite browser opens arbitrary files. Jekyll needs a Ruby toolchain from
  `~`. The issues canvas needs the network and a token. Each needs escalation,
  and designing the permissions language, prompts and defaults is bigger work
  than the sandbox itself.
- **Breaks the host transport.** `utilityProcess.fork` can't be launched inside
  `sandbox-exec` or bubblewrap. The host would become a plain Node process
  (`ELECTRON_RUN_AS_NODE`) started through the wrapper, talking over stdio or
  a socket instead of a `MessagePort`.
- **Domain rules need a proxy.** OS sandboxes filter by IP and port, not
  hostname. Allowing only `api.github.com` means a filtering proxy in main with
  the canvas's traffic forced through it, as Claude Code does.
- **Child processes are confined too.** That's good for security, but `git`,
  `bun`, `sqlite3` and winget all run under the same policy, which is a common
  source of confusing breakage.
- **Harder to debug.** Denials show up as generic `EPERM` / `ENOENT`. Canvas
  authors, including the agent, need "blocked by sandbox: X" messages, which
  means parsing per-OS denial logs.
- **Ongoing cost.** Three OS backends need CI coverage, and OS updates can
  break the policies (macOS in particular).
- **False sense of security if partial.** If Windows is unsandboxed or policies
  are loose, users may trust it more than they should.

**What v1 does to keep the door open**

1. All host launching goes through `spawnCanvasHost()` in `CanvasHostManager`.
2. The manifest's `permissions` field (`fs` / `network` / `exec`) ships from
   day one and is shown in the trust prompt, so users see what the canvas
   intends and a future sandbox already has its policy.
3. When it's time, start with **opt-in, project-tier canvases on macOS and
   Linux**, reusing Codex's and Claude Code's backends and policies. Windows
   waits for a clear AppContainer approach.

### Main-process module layout

| Module | Role |
|---|---|
| `electron/canvas/manifest.ts` | zod schema for `canvas.json` |
| `electron/canvas/discovery.ts` | Scan project / global / built-in tiers |
| `electron/canvas/store.ts` | CRUD over `canvases` / `session_canvases` / `canvas_trust`; state persistence + revision |
| `electron/canvas/host-manager.ts` | `CanvasHostManager` — spawn / stop / restart / idle-stop `utilityProcess` hosts; dev-reload watcher; `MessagePort` routing |
| `electron/canvas/host/` | Code that runs **inside** the host: SDK (`defineCanvas`, `ctx`), module loader, message loop |
| `electron/canvas/mcp-endpoint.ts` | Loopback streamable-HTTP MCP server: auth, scoping, approval gate, forwarding to hosts |
| `electron/canvas/protocol.ts` | `aichemist-canvas://` handler + CSP |
| `electron/canvas/agent-bridge.ts` | `ctx.agent.send` → `enqueueTurn`, rate limiting |
| `electron/ipc/canvas-handlers.ts` | IPC handlers (below) |

The injection hook: wherever runners call
`loadManagedMcpServers({ excludeNames })`, merge in
`canvasMcpServersForSession(db, sessionId)`.

### IPC surface

| Channel | Kind | Purpose |
|---|---|---|
| `CANVAS_LIST_DEFINITIONS` | req/res | Discovered definitions for a project (+ trust state, manifest errors) |
| `CANVAS_LIST` | req/res | Instances for a project (+ attachment for a session) |
| `CANVAS_CREATE` / `CANVAS_DELETE` / `CANVAS_RENAME` | req/res | Instance management (`CREATE` zod-validated) |
| `CANVAS_ATTACH` | req/res | Toggle an instance on/off for a session |
| `CANVAS_TRUST` | req/res | Record consent for a project definition (hash-bound) |
| `CANVAS_OPEN` / `CANVAS_CLOSE` | req/res | Panel lifecycle → start host / allow idle stop; returns `{ state, revision }` |
| `CANVAS_UI_MESSAGE` | req/res | UI → server (`onUiMessage`), zod-validated |
| `CANVAS_RESTART` | req/res | Manual host restart |
| `CANVAS_EVENT` | push | `{ canvasId, kind: "state" \| "message" \| "status" \| "log", … }` |

Each follows the standard checklist: `ipc-channels.ts` → `ipc-contract.ts` →
validator → handler → `preload.ts` → `src/lib/ipc.ts`.

### Renderer

- New `"canvas"` tab in `ToolStrip` / `ContextPanel` (icon: `LayoutDashboard`),
  lazy-loaded like `TracesPanel`.
- `CanvasPanel`: instance picker, "New canvas…" from definitions, attach
  toggle for the active session, host status (starting / running / crashed /
  untrusted), a debug drawer (logs), and the `CanvasFrame`.
- Canvas message bubbles in `TimelinePanel` get a small canvas badge
  (`message.source`).
- `useCanvasStore` (Zustand, not persisted): `stateByCanvas`,
  `revisionByCanvas`, `statusByCanvas`; `useSessionEvents` routes
  `CANVAS_EVENT` into it.
- Auto-switch to the Canvas tab when an agent tool call targets a canvas and
  the panel is closed (reuse `tabSwitchRequest`, as `ChangesPanel` does).
- Settings hub: a **Canvases** section — definitions by tier, trust state
  (revoke), manifest errors — mirroring Skills / Agents.
- Later: pop a canvas out into its own chromeless `BrowserWindow`.

### Agent awareness and `/create-canvas`

"The agent knows what a canvas is" — so:

- Every turn's system context carries a one-paragraph note that canvases
  exist and that the `create-canvas` skill can build one (cheap; no tool
  cost).
- A bundled `create-canvas` skill documents the folder layout, the manifest,
  the server SDK, the UI client helper and the trust/reload flow, with the
  kanban built-in as a worked example. The agent writes the definition to
  `<projectPath>/.agents/canvases/<name>/` (or the global dir on request),
  creates an instance, attaches it, and the dev-reload watcher opens it.

## Alternatives considered

- **Declarative-only canvases** (tools as JSON-Patch templates over a state
  document, no server code) — the earlier draft of this doc. Safe, but can't
  implement any of the showcased canvases (winget, SQLite, Jekyll, GitHub
  issues, turn-starting Connect 4). Rejected as the primary model.
- **Canvas code in the main process** — simplest, but a canvas crash or busy
  loop takes down the app and canvas code sits next to every privileged
  handler. Rejected in favour of `utilityProcess`.
- **Per-provider in-process tools** (like memory tools) — five adapters, and
  still needs an MCP endpoint for Codex. The loopback MCP server is one path
  for all providers.
- **Each canvas runs its own HTTP server, iframe points at it** — closer to
  "full-stack app", but opens a port per canvas, needs CORS/auth per canvas,
  and gives the UI a network origin. The message bridge keeps the UI inert.

## Security summary

| Threat | Mitigation |
|---|---|
| Repo ships malicious canvas code | Project-tier trust prompt, content-hash bound, re-prompt on change |
| Canvas crash / hang affects app | Separate `utilityProcess`, kill + backoff restart |
| Canvas reaches AIchemist internals | No Electron privileges in host; narrow validated `MessagePort` protocol; UI in opaque-origin sandboxed iframe |
| Trusted canvas reads/writes beyond the project | **Not mitigated in v1** — declared `permissions` shown in trust prompt only; OS-level sandbox deferred |
| Canvas harvests provider keys | API-key env vars stripped from host env |
| Canvas UI exfiltrates data | CSP `connect-src 'none'` on UI; network only in (trusted) server |
| Other local processes call canvas tools | Loopback bind + per-launch bearer token + session/attachment scoping |
| Canvas floods the agent | `ctx.agent.send` rate limit; visible, badged messages |
| Path traversal via protocol | `realpath` + prefix check against `ui/` |
| Prompt injection via canvas output | Tool results are untrusted data like file reads; destructive tools default to `approval: "ask"` |

## Error handling

- Invalid manifest → skipped, shown in settings.
- Host fails to start / crashes → backoff restart, then error state with logs
  and Restart; its MCP tools return a clear "canvas unavailable" error rather
  than hanging the turn.
- Tool call timeout (default 60 s, per-tool override) → error to the agent.
- Definition deleted with instances remaining → "definition missing" state
  with export/delete; no tools offered.
- Iframe never sends `ready` → reload affordance.
- No window attached (headless workflow) → host still runs for tool calls;
  UI events are dropped and the panel hydrates via `CANVAS_OPEN`.

## Testing

- `manifest.test.ts`, `discovery.test.ts`: validation, tier suppression.
- `host-manager.test.ts`: spawn/stop/idle/backoff with a fake process factory
  (test seam like `_setCodexFactoryForTests`).
- Host SDK tests run in-process against the host message loop: `ctx.state`
  revisions, `ctx.ui.send`, handler errors → tool errors.
- `mcp-endpoint.test.ts`: token + scoping rejection, approval gate incl.
  `nonInteractive` auto-deny, forwarding, timeouts.
- `agent-bridge.test.ts`: attachment check, `enqueueTurn` wiring, rate limit,
  `source` tagging.
- Provider tests: canvas servers merged into managed MCP for attached
  canvases only; Copilot fingerprint changes on attach/detach.
- `protocol.test.ts`: traversal rejection, CSP header.
- Renderer: `CanvasFrame` with mocked `postMessage` (source check, round
  trip), `CanvasPanel` status states, timeline canvas badge.

## Phasing

1. **Runtime spine with a built-in.** Migration, store, `CanvasHostManager`,
   host SDK, loopback MCP endpoint (all providers), protocol + `CanvasFrame`,
   `CanvasPanel` tab, built-in **kanban** written against the SDK. Proves
   agent tool → state → UI and UI → state → agent read end-to-end.
2. **User canvases.** Discovery tiers, trust prompt + `canvas_trust` (showing
   declared `permissions`), dev reload, dependency install, settings-hub
   section, API-key env stripping.
3. **Server → agent and authoring.** `ctx.agent.send` + timeline badge,
   `create-canvas` skill + system-context note, auto-switch, more built-ins
   (checklist, markdown).
4. **Optional.** Opt-in OS-level sandbox for project canvases (macOS +
   Linux first), pop-out windows, per-canvas declared secrets, workflow
   `canvases` field, an importer for Copilot `.github/extensions` once that
   API is documented.

## Open questions

- Auto-attach: opt-in per session, with `attachByDefault` in the manifest as
  the opt-out escape hatch — is that the right default?
- Should workflows get a `canvases` field so a scheduled run can drive a
  board? Cheap once Phase 1 lands (`session_canvases` rows at run creation).
- When should the deferred OS-level sandbox land (see "OS-level sandboxing")?
  Does a real third-party canvas ecosystem have to appear first?
- Target Copilot's extension format directly, or only ever import it?
