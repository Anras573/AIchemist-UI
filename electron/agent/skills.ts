import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Read the body of a skill's SKILL.md (frontmatter stripped).
 * Returns null if the file cannot be found or read.
 */
function readSkillContent(skillName: string, projectPath: string): string | null {
  const candidates = [
    path.join(projectPath, ".agents", "skills", skillName, "SKILL.md"),
    path.join(os.homedir(), ".claude", "skills", skillName, "SKILL.md"),
  ];

  for (const filePath of candidates) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      // Strip YAML frontmatter (--- ... ---)
      const stripped = raw.replace(/^---[\s\S]*?---\s*/m, "").trim();
      if (stripped) return stripped;
    } catch {
      // file not found — try next candidate
    }
  }
  return null;
}

/**
 * Build a skills context block to inject into the system prompt.
 * Returns an empty string if no skills are active or all files are missing.
 */
export function buildSkillsContext(
  activeSkills: string[],
  projectPath: string
): string {
  if (activeSkills.length === 0) return "";

  const blocks: string[] = [];
  for (const name of activeSkills) {
    const content = readSkillContent(name, projectPath);
    if (content) {
      blocks.push(`## Skill: ${name}\n\n${content}`);
    }
  }

  if (blocks.length === 0) return "";

  return (
    "\n\n---\n# Active Skills\n\n" +
    "The following skills are active for this session. Apply their guidance when relevant.\n\n" +
    blocks.join("\n\n---\n\n")
  );
}
