import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Lazy-loaded cache: skill name → directory path, built from installed_plugins.json. */
let pluginSkillPathCache: Map<string, string> | null = null;

function getPluginSkillPaths(): Map<string, string> {
  if (pluginSkillPathCache !== null) return pluginSkillPathCache;

  pluginSkillPathCache = new Map();
  const pluginsFile = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
  try {
    const data = JSON.parse(fs.readFileSync(pluginsFile, "utf-8")) as {
      plugins: Record<string, Array<{ installPath: string; lastUpdated?: string }>>;
    };

    for (const entries of Object.values(data.plugins)) {
      const sorted = [...entries].sort((a, b) =>
        (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? "")
      );
      const installPath = sorted[0]?.installPath;
      if (!installPath) continue;

      const skillsDir = path.join(installPath, "skills");
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
        try {
          const content = fs.readFileSync(skillMd, "utf-8");
          const nameMatch = content.match(/^name:\s*["']?(.+?)["']?\s*$/m);
          const name = nameMatch?.[1]?.trim() || entry.name;
          if (!pluginSkillPathCache!.has(name)) {
            pluginSkillPathCache!.set(name, path.join(skillsDir, entry.name));
          }
        } catch {
          // skip
        }
      }
    }
  } catch {
    // no plugins file — leave cache empty
  }

  return pluginSkillPathCache;
}

/**
 * Read the body of a skill's SKILL.md (frontmatter stripped).
 * Returns null if the file cannot be found or read.
 */
function readSkillContent(skillName: string, projectPath: string): string | null {
  const candidates: string[] = [
    path.join(projectPath, ".agents", "skills", skillName, "SKILL.md"),
    path.join(os.homedir(), ".claude", "skills", skillName, "SKILL.md"),
  ];

  // Also check plugin skills
  const pluginDir = getPluginSkillPaths().get(skillName);
  if (pluginDir) {
    candidates.push(path.join(pluginDir, "SKILL.md"));
  }

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
