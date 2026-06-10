/**
 * Shared parser for agent markdown files (Claude and Copilot agents use the
 * same format): YAML frontmatter with `name` / `description` / optional
 * `model`, followed by a body that becomes the agent's system prompt.
 */

export interface ParsedAgentFile {
  /** `name` frontmatter field, or null when absent. */
  name: string | null;
  /** `description` frontmatter field, or "" when absent. */
  description: string;
  /** `model` frontmatter field. Omitted when absent. */
  model?: string;
  /** Trimmed markdown body after the frontmatter block. */
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/;

function frontmatterField(fm: string, field: string): string | undefined {
  const match = fm.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : undefined;
}

/** Parse an agent markdown file. Returns null when no frontmatter block exists. */
export function parseAgentMarkdown(content: string): ParsedAgentFile | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const fm = match[1];
  const model = frontmatterField(fm, "model");
  return {
    name: frontmatterField(fm, "name") ?? null,
    description: frontmatterField(fm, "description") ?? "",
    ...(model ? { model } : {}),
    body: (match[2] ?? "").trim(),
  };
}
