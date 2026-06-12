import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SkillInfo } from "../src/types/index";

/**
 * Skill discovery across the three source tiers (project → global → plugin).
 * The exact global/plugin paths depend on the provider: Claude scans
 * `~/.claude/...`, Copilot scans `~/.agents/skills` and
 * `~/.copilot/installed-plugins`.
 */

// ── Frontmatter / skill scanning helpers ─────────────────────────────────────

function parseFrontmatterField(content: string, field: string): string {
  const singleLine = content.match(new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, "m"));
  const value = singleLine?.[1]?.trim() ?? "";

  if (/^[|>][-+]?$/.test(value)) {
    const blockMatch = content.match(
      new RegExp(`^${field}:\\s*[|>][-+]?\\s*\\n((?:[ \\t]+.+\\n?)+)`, "m")
    );
    if (blockMatch) {
      return blockMatch[1]
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ");
    }
    return "";
  }

  return value;
}

function scanSkillsDir(
  dir: string,
  source: "project" | "global"
): Array<{ name: string; description: string; path: string; source: "project" | "global" }> {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((d) => {
        const skillPath = path.join(dir, d.name);
        let description = "";
        try {
          const content = fs.readFileSync(path.join(skillPath, "SKILL.md"), "utf8");
          description = parseFrontmatterField(content, "description").slice(0, 150);
        } catch {
          try {
            const content = fs.readFileSync(path.join(skillPath, "README.md"), "utf8");
            for (const line of content.split("\n")) {
              const trimmed = line.trim();
              if (trimmed && !trimmed.startsWith("#")) {
                description = trimmed.slice(0, 150);
                break;
              }
            }
          } catch {
            // no README either — description stays empty
          }
        }
        return { name: d.name, description, path: skillPath, source };
      });
  } catch {
    return [];
  }
}

type PluginSkill = { name: string; description: string; path: string; source: "plugin"; plugin: string };

interface PluginSkillsCache {
  timestamp: number;
  mtime: number;
  results: PluginSkill[];
}
let pluginSkillsCache: PluginSkillsCache | null = null;
const PLUGIN_SKILLS_CACHE_TTL_MS = 30_000;

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function scanPluginSkills(): PluginSkill[] {
  const pluginsFile = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");

  try {
    const stats = fs.statSync(pluginsFile);
    const mtime = stats.mtimeMs;
    const now = Date.now();

    if (
      pluginSkillsCache !== null &&
      pluginSkillsCache.mtime === mtime &&
      now - pluginSkillsCache.timestamp < PLUGIN_SKILLS_CACHE_TTL_MS
    ) {
      return pluginSkillsCache.results;
    }

    const data = JSON.parse(fs.readFileSync(pluginsFile, "utf-8")) as {
      plugins: Record<string, Array<{ installPath: string; lastUpdated?: string }>>;
    };

    const results: PluginSkill[] = [];
    const seen = new Set<string>();
    let hadPartialReadError = false;

    for (const [pluginKey, entries] of Object.entries(data.plugins)) {
      const sorted = [...entries].sort((a, b) =>
        (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? "")
      );
      const installPath = sorted[0]?.installPath;
      if (!installPath) continue;

      const skillsDir = path.join(installPath, "skills");
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch (error) {
        if (!isMissingPathError(error)) {
          hadPartialReadError = true;
        }
        continue;
      }

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
        let content: string;
        try {
          content = fs.readFileSync(skillMd, "utf-8");
        } catch (error) {
          if (!isMissingPathError(error)) {
            hadPartialReadError = true;
          }
          continue;
        }

        const name = parseFrontmatterField(content, "name") || entry.name;
        if (seen.has(name)) continue;
        seen.add(name);

        results.push({
          name,
          description: parseFrontmatterField(content, "description").slice(0, 150),
          path: path.join(skillsDir, entry.name),
          source: "plugin",
          plugin: pluginKey,
        });
      }
    }

    if (!hadPartialReadError) {
      pluginSkillsCache = { timestamp: now, mtime, results };
    }
    return results;
  } catch {
    return [];
  }
}

interface CopilotPluginSkillsCache {
  timestamp: number;
  snapshot: CopilotPluginSnapshotEntry[];
  results: PluginSkill[];
}
let copilotPluginSkillsCache: CopilotPluginSkillsCache | null = null;

interface CopilotPluginSnapshotEntry {
  path: string;
  kind: "file" | "dir";
  mtime: number;
  size: number;
}

function readSnapshotEntry(filePath: string, kind: "file" | "dir"): CopilotPluginSnapshotEntry | null {
  try {
    const stat = fs.statSync(filePath);
    if (kind === "file" && !stat.isFile()) return null;
    if (kind === "dir" && !stat.isDirectory()) return null;
    return { path: filePath, kind, mtime: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function isCopilotPluginSnapshotValid(snapshot: CopilotPluginSnapshotEntry[]): boolean {
  for (const entry of snapshot) {
    const current = readSnapshotEntry(entry.path, entry.kind);
    if (!current) return false;
    if (current.mtime !== entry.mtime) return false;
    if (entry.kind === "file" && current.size !== entry.size) return false;
  }
  return true;
}

function scanCopilotPluginSkills(): PluginSkill[] {
  const root = path.join(os.homedir(), ".copilot", "installed-plugins");

  const rootSnapshot = readSnapshotEntry(root, "dir");
  if (!rootSnapshot) return [];

  const now = Date.now();
  if (
    copilotPluginSkillsCache !== null &&
    now - copilotPluginSkillsCache.timestamp < PLUGIN_SKILLS_CACHE_TTL_MS &&
    isCopilotPluginSnapshotValid(copilotPluginSkillsCache.snapshot)
  ) {
    return copilotPluginSkillsCache.results;
  }

  const snapshot: CopilotPluginSnapshotEntry[] = [rootSnapshot];
  const tracked = new Set<string>([rootSnapshot.path]);
  const track = (filePath: string, kind: "file" | "dir") => {
    if (tracked.has(filePath)) return;
    tracked.add(filePath);
    const entry = readSnapshotEntry(filePath, kind);
    if (entry) snapshot.push(entry);
  };

  let scopes: fs.Dirent[];
  try {
    scopes = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: PluginSkill[] = [];
  const seen = new Set<string>();
  let hadPartialReadError = false;

  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const scopeDir = path.join(root, scope.name);
    track(scopeDir, "dir");
    let plugins: fs.Dirent[];
    try {
      plugins = fs.readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      hadPartialReadError = true;
      continue;
    }
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = path.join(scopeDir, plugin.name);
      track(pluginDir, "dir");
      const skillsDir = path.join(scopeDir, plugin.name, "skills");
      const skillsDirEntry = readSnapshotEntry(skillsDir, "dir");
      if (!skillsDirEntry) continue;
      if (!tracked.has(skillsDirEntry.path)) {
        tracked.add(skillsDirEntry.path);
        snapshot.push(skillsDirEntry);
      }
      let skillEntries: fs.Dirent[];
      try {
        skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        hadPartialReadError = true;
        continue;
      }
      for (const entry of skillEntries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
        let content: string;
        try {
          content = fs.readFileSync(skillMd, "utf-8");
        } catch (error) {
          if (!isMissingPathError(error)) {
            hadPartialReadError = true;
          }
          continue;
        }
        track(skillMd, "file");
        const name = parseFrontmatterField(content, "name") || entry.name;
        if (seen.has(name)) continue;
        seen.add(name);
        results.push({
          name,
          description: parseFrontmatterField(content, "description").slice(0, 150),
          path: path.join(skillsDir, entry.name),
          source: "plugin",
          plugin: `${scope.name}/${plugin.name}`,
        });
      }
    }
  }

  if (!hadPartialReadError) {
    copilotPluginSkillsCache = { timestamp: now, snapshot, results };
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Global skills directory for a provider (Copilot scans `~/.agents/skills`,
 * everything else uses `~/.claude/skills`). Single source of truth shared by
 * discovery (`listSkills`) and creation (`CREATE_SKILL`) so the two paths
 * cannot diverge — a skill created for a provider must be found by the same
 * provider's scan.
 */
export function globalSkillsDir(provider?: string): string {
  return provider === "copilot"
    ? path.join(os.homedir(), ".agents", "skills")
    : path.join(os.homedir(), ".claude", "skills");
}

/**
 * List skills for a project, merging the three source tiers in priority order
 * (project → global → plugin). A higher-priority source suppresses same-named
 * skills from lower tiers. The provider selects the global/plugin scan paths;
 * undefined is treated as Claude (back-compat with the bare-string IPC form).
 */
export function listSkills(projectPath: string, provider?: string): SkillInfo[] {
  const projectSkillsDir = path.join(projectPath, ".agents", "skills");
  const projectSkills = scanSkillsDir(projectSkillsDir, "project");

  const isCopilot = provider === "copilot";
  const globalSkills = scanSkillsDir(globalSkillsDir(provider), "global");
  const pluginSkills = isCopilot ? scanCopilotPluginSkills() : scanPluginSkills();

  const projectNames = new Set(projectSkills.map((s) => s.name));
  const globalFiltered = globalSkills.filter((s) => !projectNames.has(s.name));
  const usedNames = new Set([...projectNames, ...globalFiltered.map((s) => s.name)]);
  const pluginFiltered = pluginSkills.filter((s) => !usedNames.has(s.name));

  return [...projectSkills, ...globalFiltered, ...pluginFiltered];
}

/** Test seam: clears the plugin-skill scan caches. */
export function _resetSkillsDiscoveryCaches(): void {
  pluginSkillsCache = null;
  copilotPluginSkillsCache = null;
}
