import { describe, it, expect } from "vitest";
import { languageForPath } from "./languageForPath";

describe("languageForPath", () => {
  it.each([
    ["src/a.ts", "typescript"],
    ["src/A.TSX", "tsx"],
    ["x/y/app.mjs", "javascript"],
    ["package.json", "json"],
    ["README.md", "markdown"],
    ["ci.yml", "yaml"],
    ["scripts/run.sh", "bash"],
    ["C:\\proj\\main.py", "python"],
  ])("%s -> %s", (path, lang) => expect(languageForPath(path)).toBe(lang));

  it.each(["Makefile", ".env", "archive.tar.gz", "image.png", "noext."])(
    "%s is unhighlighted",
    (path) => expect(languageForPath(path)).toBe("text")
  );
});
