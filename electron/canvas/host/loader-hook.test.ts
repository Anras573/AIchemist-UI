import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANVAS_SDK_SPECIFIER,
  resolve,
  setDefinitionDirForHooks,
  type HookResolveContext,
  type NextResolve,
} from "./loader-hook";

// `resolve()` is a plain synchronous function since round 3 of review on PR
// #238 (switched from `module.register()`'s by-URL registration to
// `module.registerHooks()`) — these tests call it directly with a fake
// `nextResolve`, exercising the SDK/zod short-circuits and the import-scope
// confinement without ever calling `registerHooks()` itself (which has
// process-wide, unregisterable side effects unsafe for the shared vitest
// worker — see `loader-hook.subprocess.test.ts` for what needs a real
// registration instead).

const FAKE_CONTEXT: HookResolveContext = { conditions: [], importAttributes: {}, parentURL: undefined };

function fakeNextResolve(url: string): NextResolve {
  return () => ({ url });
}

describe("loader-hook resolve()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "loader-hook-test-"));
  });

  afterEach(() => {
    setDefinitionDirForHooks(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("short-circuits @aichemist/canvas to the built SDK path, ignoring nextResolve", () => {
    const result = resolve(CANVAS_SDK_SPECIFIER, FAKE_CONTEXT, fakeNextResolve("file:///should-not-be-used.js"));
    expect(result.shortCircuit).toBe(true);
    expect(result.url).toMatch(/canvas-sdk[/\\]sdk\.mjs$/);
    expect(result.url).not.toContain("should-not-be-used");
  });

  it("pins zod to the app's own copy via createRequire, ignoring nextResolve entirely", () => {
    // A planted "zod" nextResolve would return if the confinement here ever
    // delegated to it instead of resolving independently (the round-3 bug).
    const plantedUrl = pathToFileURL(nodePath.join(tmpDir, "node_modules", "zod", "index.js")).href;
    const result = resolve("zod", FAKE_CONTEXT, fakeNextResolve(plantedUrl));
    expect(result.shortCircuit).toBe(true);
    expect(result.url).not.toBe(plantedUrl);
    expect(result.url).toMatch(/zod/);
  });

  it("allows a resolved path inside the definition folder", () => {
    setDefinitionDirForHooks(tmpDir);
    const filePath = nodePath.join(tmpDir, "helper.mjs");
    fs.writeFileSync(filePath, "export default 1;\n");
    const result = resolve("./helper.mjs", FAKE_CONTEXT, fakeNextResolve(pathToFileURL(filePath).href));
    expect(result.url).toBe(pathToFileURL(filePath).href);
  });

  it("allows a resolved path inside the definition's own node_modules", () => {
    setDefinitionDirForHooks(tmpDir);
    const pkgDir = nodePath.join(tmpDir, "node_modules", "left-pad");
    fs.mkdirSync(pkgDir, { recursive: true });
    const filePath = nodePath.join(pkgDir, "index.js");
    fs.writeFileSync(filePath, "module.exports = () => {};\n");
    const result = resolve("left-pad", FAKE_CONTEXT, fakeNextResolve(pathToFileURL(filePath).href));
    expect(result.url).toBe(pathToFileURL(filePath).href);
  });

  it("refuses a resolved path under the definition's own ui/ folder", () => {
    setDefinitionDirForHooks(tmpDir);
    const uiFile = nodePath.join(tmpDir, "ui", "helper.js");
    fs.mkdirSync(nodePath.dirname(uiFile), { recursive: true });
    fs.writeFileSync(uiFile, "export default 1;\n");
    expect(() => resolve("./ui/helper.js", FAKE_CONTEXT, fakeNextResolve(pathToFileURL(uiFile).href))).toThrow(
      /outside its definition folder/
    );
  });

  it("refuses a resolved path outside the definition folder entirely", () => {
    setDefinitionDirForHooks(tmpDir);
    const outsideDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "loader-hook-outside-"));
    try {
      const outsideFile = nodePath.join(outsideDir, "evil.mjs");
      fs.writeFileSync(outsideFile, "export default 1;\n");
      expect(() =>
        resolve("../../../evil.mjs", FAKE_CONTEXT, fakeNextResolve(pathToFileURL(outsideFile).href))
      ).toThrow(/outside its definition folder/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not check confinement when no definition dir is set", () => {
    setDefinitionDirForHooks(null);
    const outsideDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "loader-hook-nodir-"));
    try {
      const outsideFile = nodePath.join(outsideDir, "whatever.mjs");
      fs.writeFileSync(outsideFile, "export default 1;\n");
      const result = resolve("whatever", FAKE_CONTEXT, fakeNextResolve(pathToFileURL(outsideFile).href));
      expect(result.url).toBe(pathToFileURL(outsideFile).href);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("passes through a non-file:// result (e.g. a node: builtin) unchecked", () => {
    setDefinitionDirForHooks(tmpDir);
    const result = resolve("node:fs", FAKE_CONTEXT, fakeNextResolve("node:fs"));
    expect(result.url).toBe("node:fs");
  });
});
