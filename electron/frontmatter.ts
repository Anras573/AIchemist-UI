/**
 * Shared YAML-frontmatter helpers used by agent files (`agent/agent-file.ts`)
 * and skill discovery (`skills-discovery.ts`). Supports inline `field: value`
 * plus YAML block scalars (`|` / `>`), so both call sites read frontmatter the
 * same way and cannot diverge.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/;

/**
 * Split a markdown document into its leading `---`-delimited frontmatter block
 * and the trimmed body. Returns null when no frontmatter block is present.
 */
export function splitFrontmatter(
  content: string,
): { frontmatter: string; body: string } | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  return { frontmatter: match[1], body: (match[2] ?? "").trim() };
}

/**
 * Read a single frontmatter field from `source` (either a full document or an
 * already-extracted frontmatter block). Strips surrounding quotes and supports
 * YAML block scalars (`|` / `>`), joining their indented lines with spaces.
 * Returns undefined when the field is absent.
 */
export function frontmatterField(source: string, field: string): string | undefined {
  // When `source` is a full document with a frontmatter block, scope the search
  // to that block so body lines like `name: ...` can't produce false positives.
  // Fall back to the whole string when there is no delimiter (e.g. callers that
  // already passed an extracted block).
  const scoped = splitFrontmatter(source)?.frontmatter ?? source;

  const singleLine = scoped.match(new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, "m"));
  if (!singleLine) return undefined;
  const value = singleLine[1].trim();

  // Block scalar (`|` / `>`): collect the indented lines that follow.
  if (/^[|>][-+]?$/.test(value)) {
    const blockMatch = scoped.match(
      new RegExp(`^${field}:\\s*[|>][-+]?\\s*\\n((?:[ \\t]+.+\\n?)+)`, "m"),
    );
    if (!blockMatch) return "";
    return blockMatch[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
  }

  return value;
}
