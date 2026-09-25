# Canvases — shared agent/user work surfaces

Date: 2026-09-25

## Problem

Everything an agent produces in AIchemist today is either chat text in the
timeline or a file on disk (surfaced through the Changes / Files panels). There
is no *structured, living artifact* that the agent and the user both work on:
a plan the agent ticks off as it goes, a triage board the user reorders and the
agent then acts on, a release checklist, a small dashboard.

GitHub's Copilot app ships this as **canvas extensions**
(<https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions>):
"a shared, interactive surface for a work artifact" that opens in the right
side panel, which "the agent can update … while it works, and you can edit on
that same surface". An extension is a folder (`package.json` + `extension.mjs`
+ optional JSON state) under `.github/extensions/` (team) or
`~/.copilot/extensions/` (personal); it exposes agent-callable methods (the
kanban example: `get_board`, `add_card`, `move_card`); and a `/create-canvas`
skill lets the agent author new ones.

The public docs stop there — they do not describe the rendering technology,
the extension API, or the sandbox model. This document therefore designs an
AIchemist-native equivalent inspired by the feature rather than a
wire-compatible implementation of it.

Most of the plumbing already exists: the right-hand `ContextPanel` tab strip,
per-provider tool registration (the memory tools are the closest precedent),
the approval gate, numbered SQLite migrations, and skill/agent discovery.

## Goals

- A first-class **Canvas**: a named, project-scoped artifact with persisted
  JSON state, a UI rendered in the right panel, and a set of agent-callable
  tools that read and mutate that state.
- **Two-way sync**: an agent tool call updates the open UI immediately; a user
  edit in the UI is visible to the agent on its next read — through one shared
  state-transition path, not two.
- **Works on every provider** (Claude, Copilot, Ollama, OpenAI-compatible,
  Codex), consistent with the per-session provider lock.
- **User-authored canvases** discovered from disk (project + global), and a
  `/create-canvas` skill so the agent can author new ones.
- **Safe by construction**: a canvas shipped inside a cloned repo must not be
  able to run arbitrary code in the main process or reach `window.electronAPI`.

## Non-goals

- Wire compatibility with Copilot's `extension.mjs` API (undocumented). An
  importer can be revisited once GitHub publishes the contract.
- Real-time multi-user collaboration. One app, one user; "shared" means shared
  between the user and the agent.
- Canvases that run arbitrary Node code in the main process (see Security).
- Canvas-specific network access. The iframe gets no network (CSP); anything
  that needs the network goes through the agent's existing tools.

## Design

### Concepts

| Term | Meaning |
|---|---|
| **Canvas definition** | A folder on disk (or a built-in) containing a manifest, UI, and optional initial state. Reusable. |
| **Canvas instance** | One definition bound to a project, with its own persisted state (e.g. "Release 2.4 checklist"). A definition can have many instances. |
| **Canvas tool** | An agent-callable operation declared by the definition, executed against an instance's state. |
| **Action** | The single state-transition unit. Both agent tool calls and UI edits are expressed as actions and go through the same reducer. |

### Definition format

```
<root>/<canvas-name>/
  canvas.json      # manifest (required)
  index.html       # UI entry (required for user canvases)
  *.js / *.css     # UI assets, loaded relatively
  initial.json     # initial state for new instances (optional)
```

`canvas.json`:

```jsonc
{
  "name": "kanban",
  "description": "Agentic kanban board",
  "version": 1,
  "entry": "index.html",
  "stateSchema": { /* JSON Schema for the state document */ },
  "tools": [
    {
      "name": "move_card",
      "description": "Move a card to another column",
      "inputSchema": { /* JSON Schema */ },
      "effect": { "kind": "patch", "ops": [ /* JSON-Patch template, see below */ ] },
      "approval": "none"          // "none" | "ask" — defaults to "none"
    },
    {
      "name": "get_board",
      "description": "Return the whole board",
      "inputSchema": { "type": "object", "properties": {} },
      "effect": { "kind": "read", "pointer": "" }
    }
  ]
}
```

Discovery locations (priority order, higher suppresses same-named lower —
same rule as skills):

| Tier | Path |
|---|---|
| Project | `<projectPath>/.agents/canvases/*/` |
| Global | `~/.aichemist/canvases/*/` |
| Built-in | shipped with the app (`kanban`, `markdown`, `checklist`) |

`.agents/` matches where project skills and Copilot agents already live.
`electron/canvas/discovery.ts` mirrors `skills-discovery.ts`, and validates
each manifest with zod; an invalid manifest is skipped with a logged reason
(and surfaced in the settings hub), never fatal.

### Declarative tool effects (v1)

To keep repo-shipped canvases from executing code in the main process, v1
tools are **declarative**. An effect is one of:

- `read` — return the value at a JSON Pointer into the state.
- `patch` — apply an RFC 6902 JSON-Patch whose values/paths may interpolate
  tool arguments (`{ "op": "add", "path": "/columns/${column}/cards/-",
  "value": { "id": "${$uuid}", "title": "${title}" } }`). Interpolation is
  done on the parsed structure, never by string-concatenating JSON.
- `move` — sugar for the common "remove from list A, insert into list B by id"
  case that is awkward to express in raw JSON-Patch.

After every mutating effect the new state is validated against
`stateSchema`; a failing patch is rejected (tool error returned to the agent,
state unchanged). This covers kanban / checklist / triage / table canvases,
which is the bulk of the documented examples.

A later phase may add **UI-hosted handlers** (the tool call is forwarded to
the canvas iframe, which computes the new state in its sandbox) for canvases
whose logic outgrows JSON-Patch — see Phasing.

### Rendering — sandboxed iframe, custom protocol

The canvas UI renders in an `<iframe sandbox="allow-scripts">` inside a new
`CanvasPanel`. Assets are served by a privileged-but-read-only custom
protocol, `aichemist-canvas://<definition-id>/<path>`, registered in the main
process (`protocol.handle`) and restricted to files *inside* the resolved
definition folder (path-traversal checked after `realpath`).

- **No `allow-same-origin`** → opaque origin: no access to the host DOM,
  cookies, storage, or `window.electronAPI`.
- **CSP** response header on every served file: `default-src
  aichemist-canvas: 'unsafe-inline'; connect-src 'none'` — no network.
- **No `<webview>`**: `webviewTag` stays disabled in `BrowserWindow`.
- Built-in canvases are plain React components rendered directly (no iframe) —
  they are app code and don't need isolation.

### Host ↔ canvas protocol (`postMessage`)

A tiny versioned message protocol, validated with zod on the host side:

| Direction | Message | Purpose |
|---|---|---|
| host → canvas | `{ type: "init", state, theme, canvas }` | First paint; `theme` carries light/dark tokens |
| host → canvas | `{ type: "state", state, revision, origin }` | New state after any action (`origin`: `"agent"` \| `"user"`) |
| canvas → host | `{ type: "action", tool, args, baseRevision }` | User edit — invokes a declared tool by name |
| canvas → host | `{ type: "ready" }` | Handshake |

Canvases can only mutate state by invoking their **own declared tools** — the
UI and the agent share one vocabulary, so there is exactly one reducer. A tiny
optional helper script (`aichemist-canvas.js`, served by the protocol) wraps
the handshake for authors.

Concurrency: every instance has a monotonically increasing `revision`. A UI
action carries `baseRevision`; the host applies actions serially per instance
(they are small, synchronous patches), so a stale `baseRevision` is simply
re-validated against the current state rather than rejected — the UI always
re-renders from the authoritative `state` push that follows.

### Data model

Migration **v8** (append to `MIGRATIONS` in `electron/db.ts`):

```sql
CREATE TABLE canvases (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  definition   TEXT NOT NULL,       -- definition name, resolved via discovery
  title        TEXT NOT NULL,
  state        TEXT NOT NULL,       -- JSON document
  revision     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE session_canvases (       -- which canvases a session exposes to its agent
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  canvas_id    TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, canvas_id)
);
```

- Instances are **project-scoped** (a board outlives any one session);
  attachment to a session is explicit, like the per-session skill toggle.
- State lives in SQLite, not in the definition folder — keeps repo checkouts
  clean and makes state survive definition edits. A definition's
  `initial.json` seeds new instances only. "Export to file" can come later for
  teams that want state committed.
- Snake-case field names in `src/types/index.ts` (`Canvas`, `CanvasDefinition`),
  per convention.

### Main-process module layout

| Module | Role |
|---|---|
| `electron/canvas/manifest.ts` | zod schema for `canvas.json`; effect interpolation |
| `electron/canvas/discovery.ts` | Scan project / global / built-in tiers |
| `electron/canvas/store.ts` | CRUD over `canvases` / `session_canvases`; `applyAction(db, canvasId, tool, args, origin)` — the single reducer: resolve effect → apply → schema-validate → bump revision → persist → emit `CANVAS_STATE` |
| `electron/canvas/protocol.ts` | `aichemist-canvas://` handler + CSP |
| `electron/canvas/tools.ts` | Provider-neutral tool list for a session: one `canvas_<canvasId-short>__<tool>` per declared tool on each attached canvas, plus `list_canvases` |
| `electron/ipc/canvas-handlers.ts` | IPC handlers (below) |

### Agent tools across providers

`tools.ts` produces provider-neutral `{ name, description, inputSchema,
execute }` entries whose `execute` calls `applyAction(..., "agent")`. Each
provider adapts them exactly as it already adapts the memory tools:

| Provider | Registration |
|---|---|
| Claude | Added to the in-process `aichemist-tools` MCP server (`createApprovalMcpServer`) |
| Copilot | `defineTool` entries. The attached-canvas set (ids + definition versions) is folded into the MCP fingerprint in `provider_state.copilot.mcpFp` so attaching/detaching forces a fresh `createSession` — `resumeSession` ignores new tools, same footgun as MCP servers |
| Ollama / OpenAI-compatible | Appended to the local tool list; executed through `runGatedTool` (so they get the approval gate + tool-call persistence + native-transcript recording for free) |
| Codex | Codex executes its own tools, so it can only reach canvases over MCP. A loopback **streamable-HTTP MCP server** (`127.0.0.1`, random port, per-launch bearer token) is injected as an extra entry in `CodexOptions.config.mcp_servers`. Deferred to Phase 3 |

Tool names are namespaced per instance so two attached boards don't collide.
Only canvases **attached to the session** contribute tools, bounding
tool-list growth. A short system-prompt addendum (like `buildMemoryContext`)
lists attached canvases and their descriptions.

Approval: `approval: "none"` tools skip the gate; `"ask"` tools go through
`requiresApproval` / `requestApproval` like any other gated tool, so
`nonInteractive` workflow runs get the existing auto-deny behaviour for free.

### IPC surface

| Channel | Kind | Purpose |
|---|---|---|
| `CANVAS_LIST_DEFINITIONS` | req/res | Discovered definitions for a project |
| `CANVAS_LIST` | req/res | Instances for a project (+ which are attached to a session) |
| `CANVAS_CREATE` | req/res | New instance from a definition (zod-validated) |
| `CANVAS_DELETE` / `CANVAS_RENAME` | req/res | Instance management |
| `CANVAS_ATTACH` | req/res | Toggle an instance on/off for a session |
| `CANVAS_GET` | req/res | `{ canvas, state, revision }` for first paint |
| `CANVAS_ACTION` | req/res | User edit → `applyAction(..., "user")` (zod-validated) |
| `CANVAS_STATE` | push | `{ canvasId, state, revision, origin }` after any action |

Each follows the standard checklist: `ipc-channels.ts` → `ipc-contract.ts` →
validator (for `CREATE` / `ACTION`) → handler → `preload.ts` → `src/lib/ipc.ts`.

### Renderer

- New `"canvas"` tab in `ToolStrip` / `ContextPanel` (icon: `LayoutDashboard`),
  **lazy-loaded** (`React.lazy` + `Suspense`) like `TracesPanel`.
- `CanvasPanel`: instance picker (with "New canvas…" from a definition list)
  plus the rendered canvas. Built-ins render as React components; user
  canvases render in the sandboxed iframe via a `CanvasFrame` component that
  owns the `postMessage` bridge.
- `useCanvasStore` (Zustand, not persisted — SQLite is the source of truth):
  `stateByCanvas`, `revisionByCanvas`, `applyStatePush()`. `useSessionEvents`
  routes `CANVAS_STATE` pushes into it.
- **Auto-switch**: when an agent tool call mutates a canvas and the panel is
  closed, reuse the existing `tabSwitchRequest` mechanism (as `ChangesPanel`
  does) to surface the Canvas tab.
- Settings hub: a **Canvases** section listing definitions (source tier,
  manifest errors), mirroring Skills / Agents sections.

### `/create-canvas` skill

A bundled skill (`.agents/skills/create-canvas/SKILL.md` template, installed
to the global tier on first run or shipped as a built-in skill) that teaches
the agent the manifest schema, the effect language, the `postMessage`
protocol, and the helper script; it writes the definition into
`<projectPath>/.agents/canvases/<name>/` with the normal `write_file` tool
(so creation is approval-gated like any file write). Discovery re-scans on
panel open, so the new definition appears without a restart.

## Security

| Threat | Mitigation |
|---|---|
| Repo-shipped canvas runs code in main process | v1 effects are declarative data only; no `require`/`import` of canvas files in main |
| Canvas UI reaches `window.electronAPI` / host DOM | `sandbox="allow-scripts"` without `allow-same-origin` → opaque origin |
| Canvas exfiltrates data | CSP `connect-src 'none'`; no network in iframe |
| Path traversal via protocol | `realpath` + prefix check against the definition folder |
| Forged `postMessage` | Host checks `event.source === iframe.contentWindow`; payloads zod-validated; actions limited to that canvas's declared tools |
| Oversized state | Cap state JSON (e.g. 1 MB) in `applyAction`; reject with `invalid_input` |
| Prompt injection via canvas content | Canvas state is returned to the agent as tool *output* (same trust level as file reads); `"ask"` approval available for destructive tools |

Project-tier canvases come from whatever repo is open. Show a one-time
"This project provides N canvases" trust prompt before first rendering them
(persisted per project), analogous to how untrusted project MCP config should
be treated.

## Error handling

- Invalid manifest → skipped + shown in settings; never breaks discovery.
- Effect fails (bad pointer, schema violation, size cap) → tool error to the
  agent with the reason; state and revision unchanged; no push.
- Definition deleted while instances exist → instance shows a "definition
  missing" state with export/delete; its tools are not offered.
- Iframe crashes / never sends `ready` → panel shows an error with reload.
- `CANVAS_STATE` push with no window (headless workflow) → no-op; state is in
  SQLite and the panel hydrates via `CANVAS_GET` when opened.

## Testing

- `manifest.test.ts`: schema validation, interpolation (including hostile
  argument values that look like JSON-Patch paths), `move` sugar.
- `store.test.ts`: `applyAction` — revision bumps, schema rejection, size cap,
  serial application, push emission, cascade deletes.
- `discovery.test.ts`: tier priority/suppression, invalid manifests.
- `protocol.test.ts`: traversal rejection, CSP header present.
- Provider tests: canvas tools registered for attached canvases only; Copilot
  fingerprint changes on attach/detach; `runGatedTool` path for Ollama /
  OpenAI-compatible; `nonInteractive` auto-deny for `"ask"` tools.
- Renderer: `CanvasPanel` + `CanvasFrame` with a mocked iframe `postMessage`
  (source check, action round-trip, state push re-render); built-in Kanban
  component tests.

## Phasing

1. **Built-in canvases + sync loop.** Migration, `store.ts`, IPC, `CanvasPanel`
   tab, built-in `kanban` / `checklist` / `markdown` as React components, and
   canvas tools for Claude, Copilot, Ollama, OpenAI-compatible. Proves the
   agent ↔ UI loop end-to-end with no untrusted code.
2. **User-authored canvases.** Discovery, declarative manifests, custom
   protocol + sandboxed iframe, `postMessage` protocol and helper script,
   project trust prompt, settings-hub section.
3. **Authoring + reach.** `/create-canvas` skill; Codex support via the
   loopback HTTP MCP server; auto-switch polish.
4. **Optional.** UI-hosted (iframe-sandboxed) tool handlers for canvases that
   outgrow JSON-Patch; state export to a file; an importer for Copilot
   `.github/extensions` if/when that API is documented.

## Open questions

- Should a canvas auto-attach to new sessions in its project (opt-out) or stay
  opt-in? Proposal: opt-in, with a per-canvas "attach to new sessions" flag.
- Do workflows get a `canvases` field so a scheduled triage run can update a
  board? Cheap once Phase 1 lands — `session_canvases` rows at run creation.
- Is Copilot's own canvas format stable enough to target directly in Phase 4,
  or should we only ever import?
