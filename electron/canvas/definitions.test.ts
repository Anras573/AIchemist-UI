// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _setBuiltinCanvasesRootForTests,
  _setCanvasesRootForTests,
  builtinCanvasesRoot,
  isSafeDefinitionName,
  listBuiltinCanvasDefinitions,
  resolveCanvasServerPath,
  resolveCanvasUiDir,
} from "./definitions";

let globalRoot: string;

beforeEach(() => {
  globalRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-definitions-global-"));
  _setCanvasesRootForTests(globalRoot);
});

afterEach(() => {
  fs.rmSync(globalRoot, { recursive: true, force: true });
  _setCanvasesRootForTests(null);
  _setBuiltinCanvasesRootForTests(null);
});

describe("built-in tier — the real, shipped kanban definition", () => {
  it("resolves kanban's server.mjs from the real built-in root", () => {
    const serverPath = resolveCanvasServerPath("kanban");
    expect(serverPath).not.toBeNull();
    expect(fs.existsSync(serverPath!)).toBe(true);
    expect(serverPath).toBe(nodePath.join(builtinCanvasesRoot(), "kanban", "server.mjs"));
  });

  it("resolves kanban's ui/ folder from the real built-in root", () => {
    const uiDir = resolveCanvasUiDir("kanban");
    expect(uiDir).not.toBeNull();
    expect(fs.existsSync(nodePath.join(uiDir!, "index.html"))).toBe(true);
  });

  it("returns null for a name that isn't a known built-in and isn't in the global tier", () => {
    expect(resolveCanvasServerPath("not-a-real-canvas")).toBeNull();
    expect(resolveCanvasUiDir("not-a-real-canvas")).toBeNull();
  });

  it("lists kanban's manifest via CANVAS_LIST_DEFINITIONS' backing function", () => {
    const definitions = listBuiltinCanvasDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      name: "kanban",
      server: "server.mjs",
      ui: "ui/index.html",
    });
    expect(typeof definitions[0].description).toBe("string");
  });
});

describe("built-in tier — with a fake root (tier priority + fail-safety)", () => {
  let builtinRoot: string;

  beforeEach(() => {
    builtinRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-definitions-builtin-"));
    _setBuiltinCanvasesRootForTests(builtinRoot);
  });

  afterEach(() => {
    fs.rmSync(builtinRoot, { recursive: true, force: true });
  });

  function writeBuiltin(name: string, relative: string, content: string): void {
    const full = nodePath.join(builtinRoot, name, relative);
    fs.mkdirSync(nodePath.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  function writeGlobal(name: string, relative: string, content: string): void {
    const full = nodePath.join(globalRoot, name, relative);
    fs.mkdirSync(nodePath.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it("falls back to the built-in tier when a known built-in name has no global override", () => {
    writeBuiltin("kanban", "server.mjs", "export default {};");
    writeBuiltin("kanban", "ui/index.html", "<html></html>");

    expect(resolveCanvasServerPath("kanban")).toBe(nodePath.join(builtinRoot, "kanban", "server.mjs"));
    expect(resolveCanvasUiDir("kanban")).toBe(nodePath.join(builtinRoot, "kanban", "ui"));
  });

  it("prefers a global-tier definition over a same-named built-in", () => {
    writeBuiltin("kanban", "server.mjs", "export default {};");
    writeGlobal("kanban", "server.mjs", "export default { fromGlobal: true };");

    expect(resolveCanvasServerPath("kanban")).toBe(nodePath.join(globalRoot, "kanban", "server.mjs"));
  });

  it("never resolves a name outside the hardcoded built-in registry, even if a matching folder exists on disk", () => {
    writeBuiltin("not-registered", "server.mjs", "export default {};");
    expect(resolveCanvasServerPath("not-registered")).toBeNull();
  });

  it("rejects a path-traversal definition name for both tiers", () => {
    expect(isSafeDefinitionName("../../etc")).toBe(false);
    expect(resolveCanvasServerPath("../../etc")).toBeNull();
  });

  it("listBuiltinCanvasDefinitions skips a built-in with a missing or invalid manifest, logging rather than throwing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // No canvas.json written for "kanban" in this fake root at all.
    expect(() => listBuiltinCanvasDefinitions()).not.toThrow();
    expect(listBuiltinCanvasDefinitions()).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
