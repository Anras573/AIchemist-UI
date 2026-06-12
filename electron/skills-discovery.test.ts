// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeDirs: string[] = [];

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => homeDirs[homeDirs.length - 1] ?? actual.homedir(),
  };
});

import { listSkills, _resetSkillsDiscoveryCaches } from "./skills-discovery";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(baseDir: string, name: string, frontmatter: string): void {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter, "utf8");
}

describe("listSkills", () => {
  beforeEach(() => {
    _resetSkillsDiscoveryCaches();
    homeDirs.push(makeTempDir("skills-home-"));
  });

  afterEach(() => {
    homeDirs.pop();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("returns project skills with frontmatter descriptions", () => {
    const project = makeTempDir("skills-project-");
    writeSkill(
      path.join(project, ".agents", "skills"),
      "review",
      "---\nname: review\ndescription: Reviews code\n---\nbody"
    );

    const skills = listSkills(project);
    expect(skills).toEqual([
      expect.objectContaining({ name: "review", description: "Reviews code", source: "project" }),
    ]);
  });

  it("falls back to the first README paragraph when SKILL.md is missing", () => {
    const project = makeTempDir("skills-project-");
    const dir = path.join(project, ".agents", "skills", "docs-skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "# Heading\n\nFirst real paragraph.\n", "utf8");

    const skills = listSkills(project);
    expect(skills[0]).toMatchObject({ name: "docs-skill", description: "First real paragraph." });
  });

  it("suppresses same-named global skills behind project skills", () => {
    const project = makeTempDir("skills-project-");
    const home = homeDirs[homeDirs.length - 1];
    writeSkill(path.join(project, ".agents", "skills"), "review", "---\nname: review\ndescription: project tier\n---\n");
    writeSkill(path.join(home, ".claude", "skills"), "review", "---\nname: review\ndescription: global tier\n---\n");
    writeSkill(path.join(home, ".claude", "skills"), "global-only", "---\nname: global-only\ndescription: from global\n---\n");

    const skills = listSkills(project);
    expect(skills).toHaveLength(2);
    expect(skills.find((s) => s.name === "review")).toMatchObject({ source: "project", description: "project tier" });
    expect(skills.find((s) => s.name === "global-only")).toMatchObject({ source: "global" });
  });

  it("scans the Copilot global dir when provider is copilot", () => {
    const project = makeTempDir("skills-project-");
    const home = homeDirs[homeDirs.length - 1];
    writeSkill(path.join(home, ".agents", "skills"), "copilot-skill", "---\nname: copilot-skill\ndescription: copilot global\n---\n");
    writeSkill(path.join(home, ".claude", "skills"), "claude-skill", "---\nname: claude-skill\ndescription: claude global\n---\n");

    const copilotSkills = listSkills(project, "copilot");
    expect(copilotSkills.map((s) => s.name)).toEqual(["copilot-skill"]);

    const claudeSkills = listSkills(project);
    expect(claudeSkills.map((s) => s.name)).toEqual(["claude-skill"]);
  });

  it("returns an empty list when no skill directories exist", () => {
    const project = makeTempDir("skills-project-");
    expect(listSkills(project)).toEqual([]);
  });
});
