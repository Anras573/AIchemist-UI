---
name: create-canvas
description: Build a canvas — a full-stack work surface (server tools + sandboxed UI) that you and the user both operate on.
---
# Building a canvas

A canvas is a folder that AIchemist runs for you: a **server module** whose tools you can call, a **UI** the user sees in the Canvas tab, and **persisted JSON state** shared by both. Kanban, checklist and markdown ship built in (`electron/canvas/builtin/<name>/` in the app) — kanban is the reference example.

## 1. Folder layout

Write the definition with the normal `write_file` tool (approval-gated) to:

- `<projectPath>/.agents/canvases/<name>/` — default (project tier)
- `~/.aichemist/canvases/<name>/` — only if the user asks for a global canvas

```
<name>/
  canvas.json     manifest
  server.mjs      server module (runs in an isolated host process)
  ui/index.html   UI, plus any css/js beside it
```

`<name>` must match `[a-zA-Z0-9][a-zA-Z0-9._-]*`. Keep everything the server imports **inside this folder** (imports outside it, and anything under `ui/`, are blocked). No symlinks.

## 2. `canvas.json`

```json
{
  "name": "<name>",
  "description": "One line shown in the picker.",
  "version": 1,
  "server": "server.mjs",
  "ui": "ui/index.html",
  "attachByDefault": false,
  "permissions": {}
}
```

`permissions` is declarative only — it is shown to the user in the trust prompt but **not enforced**. Declare honestly what the server touches (e.g. `{ "network": ["api.example.com"] }`).

## 3. `server.mjs` — the server SDK

```js
import { defineCanvas, z } from "@aichemist/canvas"; // resolved for you; no install needed

export default defineCanvas({
  initialState: { items: [] },
  tools: {
    list_items: {
      description: "Return every item.",
      input: z.object({}),
      approval: "none",            // "none" | "ask" (default "ask")
      handler: (_args, ctx) => ctx.state.get(),
    },
    add_item: {
      description: "Add an item.",
      input: z.object({ text: z.string().min(1) }),
      approval: "none",
      handler: (args, ctx) => {
        ctx.state.update((s) => ({ items: [...s.items, { id: crypto.randomUUID(), text: args.text }] }));
        return { ok: true };
      },
    },
  },
  // Messages the UI sends with canvas.send(...). Apply the SAME reducers the tools use.
  onUiMessage(message, ctx) {
    if (message?.type === "add") ctx.state.update((s) => ({ items: [...s.items, { id: crypto.randomUUID(), text: String(message.text) }] }));
  },
});
```

- `ctx.state.get()` / `ctx.state.update(fn)` — state persists and is pushed to the UI on every change.
- `ctx.log(...)` — shows in the panel's debug drawer.
- `ctx.agent.send(text)` — sends a message to the attached session as if from the user (rate-limited; use sparingly).
- Read-only tools → `approval: "none"`. Tools that delete or overwrite existing data → `"ask"`.
- Throw an `Error` from a handler to give the model a useful message.
- Best practice: put pure state-transform functions in their own module, imported by both `tools` and `onUiMessage` (see kanban's `board.mjs`).

## 4. UI (`ui/`)

Plain HTML/CSS/JS, **no build step**. It runs in a sandboxed iframe: no network, no storage, no access to the app. Only files under `ui/` are served. Include the client helper first:

```html
<script src="/aichemist-canvas-client.js"></script>
<script src="app.js"></script>
```

```js
canvas.onState((state) => render(state));   // fires on every change (and initially)
canvas.onMessage((msg) => { /* server → UI messages */ });
canvas.send({ type: "add", text: "hello" }); // UI → server onUiMessage
canvas.getState();
```

Notes: never use `<form>` (submit is blocked in the sandbox) — use buttons + `keydown`. The panel sets `data-theme="dark"` on `<html>` in dark mode; define light/dark CSS variables. Build DOM with `textContent`, not `innerHTML`, for state-derived text.

## 5. Trust, reload, and attaching

1. After writing the files the definition appears in the Canvas tab's "New canvas…" picker (dev reload picks up edits without a restart).
2. **Project-tier canvases are untrusted until the user approves.** The panel previews the UI and shows a trust prompt (manifest, dependencies, hash). Tell the user to review and click "Trust and run". Any later edit to the server code re-prompts.
3. Create an instance and attach it to this session so its tools become available to you (the user does this from the panel; tools appear as `canvas-*` MCP tools on your next turn).
4. When you call a canvas tool the Canvas tab is brought to the front automatically.

## Worked example

Read the built-in kanban in the app: `electron/canvas/builtin/kanban/` — `board.mjs` (pure reducers), `definition.mjs` (tools + `onUiMessage`), `server.mjs` (two lines), `ui/`. `checklist` and `markdown` are smaller variations.
