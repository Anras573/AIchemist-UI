// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _setBuiltinCanvasesRootForTests, _setCanvasesRootForTests } from "./definitions";
import { discoverCanvasDefinitions } from "./discovery";

let globalRoot: string;
let builtinRoot: string;
let projectRoot: string;

function writeManifest(root: string, name: string, manifest: unknown): void {
  const dir = nodePath.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(nodePath.join(dir, "canvas.json"), JSON.stringify(manifest));
}

function writeRaw(root: string, name: string, contents: string): void {
  const dir = nodePath.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(nodePath.join(dir, "canvas.json"), contents);
}

function manifestFor(name: string, overrides: Record<string, unknown> = {}) {
  return { name, description: "", version: 1, server: "server.mjs", ui: "ui/index.html", ...overrides };
}

beforeEach(() => {
  globalRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-discovery-global-"));
  builtinRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-discovery-builtin-"));
  projectRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "canvas-discovery-project-"));
  _setCanvasesRootForTests(globalRoot);
  _setBuiltinCanvasesRootForTests(builtinRoot);
});

afterEach(() => {
  fs.rmSync(globalRoot, { recursive: true, force: true });
  fs.rmSync(builtinRoot, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
  _setCanvasesRootForTests(null);
  _setBuiltinCanvasesRootForTests(null);
});

describe("discoverCanvasDefinitions", () => {
  it("returns nothing when no tier directory exists", () => {
    const result = discoverCanvasDefinitions();
    expect(result).toEqual({ definitions: [], errors: [] });
  });

  it("lists definitions from all three tiers", () => {
    writeManifest(builtinRoot, "kanban", manifestFor("kanban"));
    writeManifest(globalRoot, "sqlite-browser", manifestFor("sqlite-browser"));
    writeManifest(nodePath.join(projectRoot, ".agents", "canvases"), "board", manifestFor("board"));

    const result = discoverCanvasDefinitions(projectRoot);

    expect(result.errors).toEqual([]);
    const ids = result.definitions.map((d) => d.id).sort();
    expect(ids).toEqual(["board", "kanban", "sqlite-browser"]);

    const tiers = Object.fromEntries(result.definitions.map((d) => [d.id, d.tier]));
    expect(tiers).toEqual({ board: "project", kanban: "builtin", "sqlite-browser": "global" });
  });

  it("omits the project tier entirely when no projectPath is given", () => {
    writeManifest(nodePath.join(projectRoot, ".agents", "canvases"), "board", manifestFor("board"));
    const result = discoverCanvasDefinitions();
    expect(result.definitions).toEqual([]);
  });

  it("a project-tier definition suppresses a same-named global one, which suppresses a same-named built-in one", () => {
    writeManifest(builtinRoot, "kanban", manifestFor("kanban", { description: "builtin" }));
    writeManifest(globalRoot, "kanban", manifestFor("kanban", { description: "global" }));
    writeManifest(nodePath.join(projectRoot, ".agents", "canvases"), "kanban", manifestFor("kanban", { description: "project" }));

    const result = discoverCanvasDefinitions(projectRoot);

    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0].tier).toBe("project");
    expect(result.definitions[0].manifest.description).toBe("project");
  });

  it("global suppresses built-in when there is no project override", () => {
    writeManifest(builtinRoot, "kanban", manifestFor("kanban", { description: "builtin" }));
    writeManifest(globalRoot, "kanban", manifestFor("kanban", { description: "global" }));

    const result = discoverCanvasDefinitions(projectRoot);

    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0].tier).toBe("global");
  });

  it("skips a non-directory entry in a tier root", () => {
    fs.mkdirSync(globalRoot, { recursive: true });
    fs.writeFileSync(nodePath.join(globalRoot, "not-a-dir.txt"), "hello");
    writeManifest(globalRoot, "kanban", manifestFor("kanban"));

    const result = discoverCanvasDefinitions();
    expect(result.definitions.map((d) => d.id)).toEqual(["kanban"]);
    expect(result.errors).toEqual([]);
  });

  it("skips an unsafe folder name (path traversal) without treating it as an error", () => {
    // isSafeDefinitionName rejects names starting with "." — mkdirSync still
    // allows creating it on disk, exercising the discovery-side guard.
    writeManifest(globalRoot, ".hidden", manifestFor(".hidden"));
    const result = discoverCanvasDefinitions();
    expect(result.definitions).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("reports a missing canvas.json as an error, keyed by folder name and tier", () => {
    fs.mkdirSync(nodePath.join(globalRoot, "empty-folder"), { recursive: true });

    const result = discoverCanvasDefinitions();

    expect(result.definitions).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ id: "empty-folder", tier: "global" });
    expect(result.errors[0].reason).toContain("could not be read");
  });

  it("reports invalid JSON as an error", () => {
    writeRaw(globalRoot, "broken", "{ not json");

    const result = discoverCanvasDefinitions();

    expect(result.definitions).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ id: "broken", tier: "global" });
    expect(result.errors[0].reason).toContain("not valid JSON");
  });

  it("reports a manifest that fails schema validation as an error", () => {
    writeManifest(globalRoot, "bad-manifest", { name: "", version: 1, server: "server.mjs", ui: "ui/index.html" });

    const result = discoverCanvasDefinitions();

    expect(result.definitions).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ id: "bad-manifest", tier: "global" });
    expect(result.errors[0].reason).toContain("name");
  });

  it("an invalid manifest in one tier never breaks discovery of the rest", () => {
    writeRaw(globalRoot, "broken", "{ not json");
    writeManifest(globalRoot, "kanban", manifestFor("kanban"));
    writeManifest(builtinRoot, "checklist", manifestFor("checklist"));

    const result = discoverCanvasDefinitions();

    expect(result.definitions.map((d) => d.id).sort()).toEqual(["checklist", "kanban"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].id).toBe("broken");
  });

  it("a project-tier definition is listed even though it can never be started (resolution never looks at the project tier)", () => {
    writeManifest(nodePath.join(projectRoot, ".agents", "canvases"), "board", manifestFor("board"));
    const result = discoverCanvasDefinitions(projectRoot);
    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0].tier).toBe("project");
  });
});
