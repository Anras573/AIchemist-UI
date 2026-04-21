// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("os");

import * as fs from "fs";
import * as os from "os";

// Re-import after mocks so the module initialises with mocked fs/os.
// Each test file gets its own module instance in Vitest (isolate: true is default for node env).
import { buildSkillsContext, _resetPluginSkillCache } from "./skills";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(name: string, isDirectory = true): fs.Dirent {
  return { name, isDirectory: () => isDirectory, isFile: () => !isDirectory } as unknown as fs.Dirent;
}

// ─── buildSkillsContext ───────────────────────────────────────────────────────

describe("buildSkillsContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPluginSkillCache();
    vi.mocked(os.homedir).mockReturnValue("/home/user");
    // Default: no plugins file
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      throw Object.assign(new Error("ENOENT: " + filePath), { code: "ENOENT" });
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it("returns empty string when no skills are active", () => {
    expect(buildSkillsContext([], "/project")).toBe("");
  });

  it("returns empty string when all skill files are missing", () => {
    expect(buildSkillsContext(["missing-skill"], "/project")).toBe("");
  });

  it("includes content from a project-local skill", () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath) === "/project/.agents/skills/my-skill/SKILL.md") {
        return "---\nname: my-skill\n---\n\nDo the thing.";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = buildSkillsContext(["my-skill"], "/project");
    expect(result).toContain("Do the thing.");
    expect(result).toContain("my-skill");
  });

  it("falls back to the global skill when project skill is missing", () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath) === "/home/user/.claude/skills/global-skill/SKILL.md") {
        return "---\nname: global-skill\n---\n\nGlobal guidance.";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = buildSkillsContext(["global-skill"], "/project");
    expect(result).toContain("Global guidance.");
  });

  it("falls back to a plugin skill when project and global are missing", () => {
    const pluginsJson = JSON.stringify({
      plugins: {
        "my-org/my-plugin": [
          {
            installPath: "/home/user/.claude/plugins/my-plugin@1.0.0",
            lastUpdated: "2024-01-01T00:00:00Z",
          },
        ],
      },
    });

    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      const p = String(filePath);
      if (p.endsWith("installed_plugins.json")) return pluginsJson;
      if (p === "/home/user/.claude/plugins/my-plugin@1.0.0/skills/plugin-skill/SKILL.md") {
        return "---\nname: plugin-skill\ndescription: Plugin skill\n---\n\nPlugin content.";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vi.mocked(fs.readdirSync) as any).mockImplementation((dir: string) => {
      if (String(dir) === "/home/user/.claude/plugins/my-plugin@1.0.0/skills") {
        return [makeEntry("plugin-skill")];
      }
      return [];
    });

    const result = buildSkillsContext(["plugin-skill"], "/project");
    expect(result).toContain("Plugin content.");
  });

  it("strips frontmatter before including skill content", () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath) === "/project/.agents/skills/my-skill/SKILL.md") {
        return "---\nname: my-skill\ndescription: A skill\n---\n\nActual instructions here.";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = buildSkillsContext(["my-skill"], "/project");
    expect(result).not.toContain("description:");
    expect(result).toContain("Actual instructions here.");
  });

  it("combines multiple skills", () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      const p = String(filePath);
      if (p === "/project/.agents/skills/skill-a/SKILL.md") return "---\n---\n\nInstructions A.";
      if (p === "/project/.agents/skills/skill-b/SKILL.md") return "---\n---\n\nInstructions B.";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = buildSkillsContext(["skill-a", "skill-b"], "/project");
    expect(result).toContain("Instructions A.");
    expect(result).toContain("Instructions B.");
  });

  it("falls back to the Copilot user-global skill dir (~/.agents/skills/)", () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath) === "/home/user/.agents/skills/copilot-user-skill/SKILL.md") {
        return "---\nname: copilot-user-skill\n---\n\nCopilot user content.";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = buildSkillsContext(["copilot-user-skill"], "/project");
    expect(result).toContain("Copilot user content.");
  });

  it("falls back to a Copilot plugin skill (~/.copilot/installed-plugins/...)", () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      const p = String(filePath);
      if (p === "/home/user/.copilot/installed-plugins/scope/myplugin/skills/copilot-plugin-skill/SKILL.md") {
        return "---\nname: copilot-plugin-skill\n---\n\nCopilot plugin content.";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vi.mocked(fs.readdirSync) as any).mockImplementation((dir: string) => {
      const d = String(dir);
      if (d === "/home/user/.copilot/installed-plugins") return [makeEntry("scope")];
      if (d === "/home/user/.copilot/installed-plugins/scope") return [makeEntry("myplugin")];
      if (d === "/home/user/.copilot/installed-plugins/scope/myplugin/skills") {
        return [makeEntry("copilot-plugin-skill")];
      }
      return [];
    });

    const result = buildSkillsContext(["copilot-plugin-skill"], "/project");
    expect(result).toContain("Copilot plugin content.");
  });

  it("prefers project skill over Copilot user-global with the same name", () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      const p = String(filePath);
      if (p === "/project/.agents/skills/dup/SKILL.md") {
        return "---\nname: dup\n---\n\nProject wins.";
      }
      if (p === "/home/user/.agents/skills/dup/SKILL.md") {
        return "---\nname: dup\n---\n\nCopilot user loses.";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = buildSkillsContext(["dup"], "/project");
    expect(result).toContain("Project wins.");
    expect(result).not.toContain("Copilot user loses.");
  });
});
