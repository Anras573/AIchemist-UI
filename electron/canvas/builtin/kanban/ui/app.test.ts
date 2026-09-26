// @vitest-environment jsdom
//
// `app.js` is a plain, unbundled script served straight to the sandboxed
// iframe (no build step, matching the protocol's contract) — this test loads
// its real source into jsdom against the real `index.html` markup, so it
// exercises the actual DOM the UI renders rather than a rewritten stand-in.
//
// jsdom does not enforce iframe sandboxing (a form's `submit` event fires
// there even under `sandbox="allow-scripts"` with no `allow-forms`, unlike a
// real browser), so it can't reproduce the sandbox block itself — this test
// instead asserts the structural fix: no `<form>` anywhere in the rendered
// board, and "Add card" is driven by a click/keydown handler.
//
// Typed loosely (`any`) rather than pulling in the "dom" lib: this file lives
// under `electron/`, type-checked as one program by `tsconfig.electron.json`
// (no "dom" lib — main-process code has no business using browser globals),
// and a `/// <reference lib="dom" />` here would add DOM's ambient globals
// (e.g. `Response`) to that *whole* program, clashing with Node's own
// (`electron/canvas/protocol.ts` already uses the platform `Response`). These
// local `declare`s scope the browser globals to just this file instead.
declare const document: any;
declare const window: any;
declare const KeyboardEvent: any;

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS_SOURCE = fs.readFileSync(nodePath.join(__dirname, "app.js"), "utf8");
const INDEX_HTML = fs.readFileSync(nodePath.join(__dirname, "index.html"), "utf8");

const EMPTY_BOARD = { columns: { todo: [], doing: [], done: [] } };

function loadApp(send: (message: unknown) => void) {
  const bodyMatch = INDEX_HTML.match(/<body>([\s\S]*)<\/body>/);
  if (!bodyMatch) throw new Error("index.html has no <body> to load into jsdom");
  document.body.innerHTML = bodyMatch[1];

  let onState: ((state: unknown) => void) | undefined;
  window.canvas = {
    onState: (fn: (state: unknown) => void) => {
      onState = fn;
    },
    onMessage: () => {},
    send,
    getState: () => EMPTY_BOARD,
  };

  // eslint-disable-next-line no-eval -- loading the real, unbundled script source, not arbitrary input.
  (0, eval)(APP_JS_SOURCE);
  if (!onState) throw new Error("app.js never called canvas.onState");
  return { render: onState };
}

describe("kanban ui/app.js — add card", () => {
  let send: ReturnType<typeof vi.fn<(message: unknown) => void>>;

  beforeEach(() => {
    send = vi.fn<(message: unknown) => void>();
  });

  it("never renders a <form> anywhere on the board (a real submit would be blocked by the sandbox)", () => {
    const { render } = loadApp(send);
    render(EMPTY_BOARD);
    expect(document.querySelectorAll("form")).toHaveLength(0);
  });

  it("clicking Add sends an `add` message with the column and trimmed title", () => {
    const { render } = loadApp(send);
    render(EMPTY_BOARD);

    const todoColumn = document.querySelector('.card-list[data-column="todo"]').closest(".column");
    todoColumn.querySelector(".add-card-toggle").click();

    const input = todoColumn.querySelector(".add-card-form input");
    input.value = "  Ship the fix  ";
    todoColumn.querySelector(".add-card-form button").click();

    expect(send).toHaveBeenCalledWith({ type: "add", column: "todo", title: "Ship the fix" });
  });

  it("pressing Enter in the input also sends the `add` message", () => {
    const { render } = loadApp(send);
    render(EMPTY_BOARD);

    const doingColumn = document.querySelector('.card-list[data-column="doing"]').closest(".column");
    doingColumn.querySelector(".add-card-toggle").click();

    const input = doingColumn.querySelector(".add-card-form input");
    input.value = "Via Enter";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(send).toHaveBeenCalledWith({ type: "add", column: "doing", title: "Via Enter" });
  });

  it("does nothing for a blank title", () => {
    const { render } = loadApp(send);
    render(EMPTY_BOARD);

    const todoColumn = document.querySelector('.card-list[data-column="todo"]').closest(".column");
    todoColumn.querySelector(".add-card-toggle").click();
    todoColumn.querySelector(".add-card-form button").click();

    expect(send).not.toHaveBeenCalled();
  });
});
