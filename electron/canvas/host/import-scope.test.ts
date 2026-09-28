// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isImportAllowed, isPathWithin } from "./import-scope";

let definitionDir: string;

beforeEach(() => {
  definitionDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "import-scope-"));
});

afterEach(() => {
  fs.rmSync(definitionDir, { recursive: true, force: true });
});

describe("isImportAllowed", () => {
  it("allows a file directly inside the definition folder", () => {
    const target = nodePath.join(definitionDir, "server.mjs");
    fs.writeFileSync(target, "export default {};");
    expect(isImportAllowed(target, definitionDir)).toBe(true);
  });

  it("allows a nested module inside the definition folder", () => {
    fs.mkdirSync(nodePath.join(definitionDir, "tools"), { recursive: true });
    const target = nodePath.join(definitionDir, "tools", "helper.mjs");
    fs.writeFileSync(target, "export default {};");
    expect(isImportAllowed(target, definitionDir)).toBe(true);
  });

  it("allows a package inside the definition's own node_modules", () => {
    const dir = nodePath.join(definitionDir, "node_modules", "some-pkg");
    fs.mkdirSync(dir, { recursive: true });
    const target = nodePath.join(dir, "index.js");
    fs.writeFileSync(target, "module.exports = {};");
    expect(isImportAllowed(target, definitionDir)).toBe(true);
  });

  it("refuses a file inside the definition's ui/ folder", () => {
    fs.mkdirSync(nodePath.join(definitionDir, "ui"), { recursive: true });
    const target = nodePath.join(definitionDir, "ui", "helpers.mjs");
    fs.writeFileSync(target, "export default {};");
    expect(isImportAllowed(target, definitionDir)).toBe(false);
  });

  it("refuses a file outside the definition folder entirely (e.g. the app's own node_modules)", () => {
    const outside = fs.mkdtempSync(nodePath.join(os.tmpdir(), "import-scope-outside-"));
    try {
      const target = nodePath.join(outside, "node_modules", "helper", "index.js");
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      fs.writeFileSync(target, "module.exports = {};");
      expect(isImportAllowed(target, definitionDir)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a sibling folder that merely shares the definition folder's name as a prefix", () => {
    // e.g. definitionDir = "/foo/widgets", target = "/foo/widgets-evil/x.mjs"
    // — a naive string startsWith("/foo/widgets") check would wrongly allow this.
    const parent = nodePath.dirname(definitionDir);
    const sibling = `${definitionDir}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    try {
      const target = nodePath.join(sibling, "x.mjs");
      fs.writeFileSync(target, "export default {};");
      expect(isImportAllowed(target, definitionDir)).toBe(false);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
      void parent;
    }
  });

  it("allows a target that doesn't exist yet (fails open on the realpath lookup, matching the resolved path itself)", () => {
    const target = nodePath.join(definitionDir, "not-yet-written.mjs");
    expect(isImportAllowed(target, definitionDir)).toBe(true);
  });
});

// `isPathWithin` is the general-purpose containment check `isImportAllowed`
// itself is built on, and that `loader-hook.ts` also uses directly for its
// own trusted roots (the canvas SDK build output, the real `zod` package's
// directory — see that file's docstring on why a package's own internal
// relative imports need this rather than just its pinned entry-point file).
describe("isPathWithin", () => {
  it("treats the root itself as within the root", () => {
    expect(isPathWithin(definitionDir, definitionDir)).toBe(true);
  });

  it("allows a nested file", () => {
    const target = nodePath.join(definitionDir, "a", "b.mjs");
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export default {};");
    expect(isPathWithin(target, definitionDir)).toBe(true);
  });

  it("refuses a sibling folder that merely shares the root's name as a prefix", () => {
    const sibling = `${definitionDir}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    try {
      expect(isPathWithin(nodePath.join(sibling, "x.mjs"), definitionDir)).toBe(false);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("refuses a path outside the root entirely", () => {
    const outside = fs.mkdtempSync(nodePath.join(os.tmpdir(), "path-within-outside-"));
    try {
      expect(isPathWithin(nodePath.join(outside, "x.mjs"), definitionDir)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
