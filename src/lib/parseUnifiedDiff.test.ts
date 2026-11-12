import { describe, it, expect } from "vitest";
import { addedRows, countDiffRows, parseUnifiedDiff } from "./parseUnifiedDiff";

const kinds = (diff: string) => parseUnifiedDiff(diff).map((r) => r.kind);

describe("parseUnifiedDiff", () => {
  it("classifies a full git diff and strips +/-/space markers from code rows", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@ function f() {",
      " keep",
      "-old",
      "+new",
      " tail",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { kind: "meta", text: "diff --git a/a.ts b/a.ts" },
      { kind: "meta", text: "index 111..222 100644" },
      { kind: "meta", text: "--- a/a.ts" },
      { kind: "meta", text: "+++ b/a.ts" },
      { kind: "hunk", text: "@@ -1,3 +1,3 @@ function f() {" },
      { kind: "context", text: "keep" },
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "context", text: "tail" },
    ]);
  });

  it("does not render the empty tail after the final newline", () => {
    expect(parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b\n")).toHaveLength(3);
  });

  it("keeps a removed line that starts with '-- ' inside a hunk as removed", () => {
    // A deleted SQL comment "-- note" is emitted as "--- note".
    const rows = parseUnifiedDiff("@@ -1,2 +1,1 @@\n--- note\n keep");
    expect(rows.map((r) => r.kind)).toEqual(["hunk", "removed", "context"]);
    expect(rows[1].text).toBe("-- note");
  });

  it("treats a header line after the hunk is exhausted as meta again", () => {
    expect(
      kinds("@@ -1 +1 @@\n-a\n+b\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-c\n+d")
    ).toEqual([
      "hunk", "removed", "added",
      "meta", "meta", "meta",
      "hunk", "removed", "added",
    ]);
  });

  it("marks '\\ No newline at end of file' as meta without consuming counts", () => {
    expect(kinds("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b")).toEqual([
      "hunk", "removed", "meta", "added",
    ]);
  });

  it("treats an empty line inside a hunk as a blank context line", () => {
    expect(kinds("@@ -1,3 +1,3 @@\n a\n\n b")).toEqual([
      "hunk", "context", "context", "context",
    ]);
  });

  it("is lenient with hunk-less / truncated diffs", () => {
    expect(kinds("--- a.ts\n+++ a.ts\n+added\n-removed\n ctx")).toEqual([
      "meta", "meta", "added", "removed", "context",
    ]);
  });

  it("handles binary / mode-only entries as meta", () => {
    expect(kinds("diff --git a/x b/x\nBinary files a/x and b/x differ")).toEqual([
      "meta", "meta",
    ]);
  });

  it("returns no rows for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("addedRows / countDiffRows", () => {
  it("turns file content into added rows", () => {
    expect(addedRows("a\nb")).toEqual([
      { kind: "added", text: "a" },
      { kind: "added", text: "b" },
    ]);
  });

  it("counts only added and removed rows", () => {
    const rows = parseUnifiedDiff("--- a\n+++ b\n@@ -1,2 +1,2 @@\n-x\n+y\n z");
    expect(countDiffRows(rows)).toEqual({ added: 1, removed: 1 });
  });
});
