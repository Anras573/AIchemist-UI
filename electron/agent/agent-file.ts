/**
 * Shared parser for agent markdown files (Claude and Copilot agents use the
 * same format): YAML frontmatter with `name` / `description` / optional
 * `model`, followed by a body that becomes the agent's system prompt.
 */

import { frontmatterField, splitFrontmatter } from "../frontmatter";

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

/** Parse an agent markdown file. Returns null when no frontmatter block exists. */
export function parseAgentMarkdown(content: string): ParsedAgentFile | null {
  const split = splitFrontmatter(content);
  if (!split) return null;

  const { frontmatter, body } = split;
  const model = frontmatterField(frontmatter, "model");
  return {
    name: frontmatterField(frontmatter, "name") ?? null,
    description: frontmatterField(frontmatter, "description") ?? "",
    ...(model ? { model } : {}),
    body,
  };
}
