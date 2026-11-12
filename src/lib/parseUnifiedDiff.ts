/**
 * Splits a unified diff into typed rows for display.
 *
 * `added` / `removed` / `context` rows carry their text WITHOUT the leading
 * `+` / `-` / ` ` marker (the renderer draws the marker). `hunk` (`@@ … @@`)
 * and `meta` (`diff --git`, `index`, `---`/`+++` file headers, `\ No newline`,
 * …) rows keep their full text.
 *
 * `@@ -a,b +c,d @@` counts are tracked so a removed line that itself starts
 * with `-- ` (e.g. a deleted SQL comment, which appears as `--- …`) is not
 * mistaken for a file header while still inside a hunk.
 */

export type DiffRowKind = "meta" | "hunk" | "added" | "removed" | "context";

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string): DiffRow[] {
  const lines = diff.split("\n");
  // A diff normally ends with a newline; don't render the empty tail as a row.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const rows: DiffRow[] = [];
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of lines) {
    const inHunk = oldLeft > 0 || newLeft > 0;

    if (inHunk) {
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" — belongs to the previous line.
        rows.push({ kind: "meta", text: line });
        continue;
      }
      const marker = line[0];
      if (marker === "+") {
        newLeft = Math.max(0, newLeft - 1);
        rows.push({ kind: "added", text: line.slice(1) });
        continue;
      }
      if (marker === "-") {
        oldLeft = Math.max(0, oldLeft - 1);
        rows.push({ kind: "removed", text: line.slice(1) });
        continue;
      }
      if (marker === " " || line === "") {
        // Some tools emit an empty string (no space) for a blank context line.
        oldLeft = Math.max(0, oldLeft - 1);
        newLeft = Math.max(0, newLeft - 1);
        rows.push({ kind: "context", text: line.slice(1) });
        continue;
      }
      // Anything else inside a hunk is malformed; fall through to header rules.
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }

    // Outside a hunk: file headers are meta; be lenient with bare +/-/space
    // lines (hand-written or truncated diffs) rather than dropping their colour.
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      rows.push({ kind: "meta", text: line });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "added", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "removed", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "context", text: line.slice(1) });
    } else {
      rows.push({ kind: "meta", text: line });
    }
  }

  return rows;
}

/** Every line of `content` as an added row — used to preview a new (untracked) file. */
export function addedRows(content: string): DiffRow[] {
  return content.split("\n").map((text) => ({ kind: "added", text }));
}

/** `+N` / `-N` line counts for a set of rows. */
export function countDiffRows(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "added") added++;
    else if (row.kind === "removed") removed++;
  }
  return { added, removed };
}
