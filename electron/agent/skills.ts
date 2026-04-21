import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Lazy-loaded cache: skill name → directory path, built from installed_plugins.json. */
let pluginSkillPathCache: Map<string, string> | null = null;
/** Lazy-loaded cache for Copilot plugin skills under ~/.copilot/installed-plugins. */
let copilotPluginSkillPathCache: Map<string, string> | null = null;

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
 * Lazy-loaded cache of Copilot plugin skill paths
 * (~/.copilot/installed-plugins/<scope>/<plugin>/skills/<name>/SKILL.md).
 */
function getCopilotPluginSkillPaths(): Map<string, string> {
  if (copilotPluginSkillPathCache !== null) return copilotPluginSkillPathCache;

  copilotPluginSkillPathCache = new Map();
  const root = path.join(os.homedir(), ".copilot", "installed-plugins");
  let scopes: fs.Dirent[];
  try {
    scopes = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return copilotPluginSkillPathCache;
  }

  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    let plugins: fs.Dirent[];
    try {
      plugins = fs.readdirSync(path.join(root, scope.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const skillsDir = path.join(root, scope.name, plugin.name, "skills");
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
        try {
          const content = fs.readFileSync(skillMd, "utf-8");
          const nameMatch = content.match(/^name:\s*["']?(.+?)["']?\s*$/m);
          const name = nameMatch?.[1]?.trim() || entry.name;
          if (!copilotPluginSkillPathCache!.has(name)) {
            copilotPluginSkillPathCache!.set(name, path.join(skillsDir, entry.name));
          }
        } catch {
          // skip
        }
      }
    }
  }

  return copilotPluginSkillPathCache;
}

/** Reset both plugin skill path caches (for testing only). */
export function _resetPluginSkillCache(): void {
  pluginSkillPathCache = null;
  copilotPluginSkillPathCache = null;
}

/**
 * Read the body of a skill's SKILL.md (frontmatter stripped).
 * Returns null if the file cannot be found or read.
 *
 * Search order: project → Claude global → Copilot global → Claude plugins
 * → Copilot plugins. The first hit wins, which matches the panel's priority.
 */
function readSkillContent(skillName: string, projectPath: string): string | null {
  const candidates: string[] = [
    path.join(projectPath, ".agents", "skills", skillName, "SKILL.md"),
    path.join(os.homedir(), ".claude", "skills", skillName, "SKILL.md"),
    path.join(os.homedir(), ".agents", "skills", skillName, "SKILL.md"),
  ];

  const claudePluginDir = getPluginSkillPaths().get(skillName);
  if (claudePluginDir) {
    candidates.push(path.join(claudePluginDir, "SKILL.md"));
  }
  const copilotPluginDir = getCopilotPluginSkillPaths().get(skillName);
  if (copilotPluginDir) {
    candidates.push(path.join(copilotPluginDir, "SKILL.md"));
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
