// @vitest-environment node
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import {
  agentFilePathFor,
  assertDirectChildOfRoots,
  assertSafeName,
  libraryRootsFor,
  skillPathFor,
} from "./library-handlers";

describe("assertSafeName", () => {
  it.each(["my-skill", "code_reviewer", "skill.v2"])("accepts plain name %s", (name) => {
    expect(() => assertSafeName(name)).not.toThrow();
  });

  it.each(["", ".", "..", "a/b", "a\\b", "../escape", "a\0b"])(
    "rejects unsafe name %j",
    (name) => {
      expect(() => assertSafeName(name)).toThrow(/invalid name/i);
    }
  );
});

describe("agentFilePathFor", () => {
  const base = { name: "my-agent", projectPath: "/project", scope: "global" as const };

  it("writes Claude agents to ~/.claude/agents", () => {
    expect(agentFilePathFor({ ...base, provider: "anthropic" })).toBe(
      path.join(os.homedir(), ".claude", "agents", "my-agent.md")
    );
  });

  it("writes Ollama-session agents to ~/.claude/agents (Ollama reads Claude agent files)", () => {
    expect(agentFilePathFor({ ...base, provider: "ollama" })).toBe(
      path.join(os.homedir(), ".claude", "agents", "my-agent.md")
    );
  });

  it("writes global Copilot agents to ~/.github-copilot/agents", () => {
    expect(agentFilePathFor({ ...base, provider: "copilot" })).toBe(
      path.join(os.homedir(), ".github-copilot", "agents", "my-agent.md")
    );
  });

  it("writes project-scope Copilot agents into the project", () => {
    expect(agentFilePathFor({ ...base, provider: "copilot", scope: "project" })).toBe(
      path.join("/project", ".agents", "copilot-agents", "my-agent.md")
    );
  });
});

describe("skillPathFor", () => {
  const base = { name: "my-skill", projectPath: "/project" };

  it("writes project-scope skills into the project", () => {
    expect(skillPathFor({ ...base, scope: "project" })).toBe(
      path.join("/project", ".agents", "skills", "my-skill")
    );
  });

  it("writes global Claude skills to ~/.claude/skills", () => {
    expect(skillPathFor({ ...base, scope: "global", provider: "anthropic" })).toBe(
      path.join(os.homedir(), ".claude", "skills", "my-skill")
    );
  });

  it("writes global Copilot skills to ~/.agents/skills (matching discovery)", () => {
    expect(skillPathFor({ ...base, scope: "global", provider: "copilot" })).toBe(
      path.join(os.homedir(), ".agents", "skills", "my-skill")
    );
  });
});

describe("libraryRootsFor", () => {
  it("includes the fixed per-user dirs and per-project library dirs", () => {
    const roots = libraryRootsFor(["/project-a", "/worktrees/feature-x"]);
    expect(roots.agents).toEqual([
      path.join(os.homedir(), ".claude", "agents"),
      path.join(os.homedir(), ".github-copilot", "agents"),
      path.join("/project-a", ".agents", "copilot-agents"),
      path.join("/worktrees/feature-x", ".agents", "copilot-agents"),
    ]);
    expect(roots.skills).toEqual([
      path.join(os.homedir(), ".claude", "skills"),
      path.join(os.homedir(), ".agents", "skills"),
      path.join("/project-a", ".agents", "skills"),
      path.join("/worktrees/feature-x", ".agents", "skills"),
    ]);
  });
});

describe("assertDirectChildOfRoots", () => {
  const roots = [path.join("/home/u", ".claude", "agents"), path.join("/project", ".agents", "skills")];

  it("accepts a direct child of a root and returns the resolved path", () => {
    expect(assertDirectChildOfRoots("/home/u/.claude/agents/reviewer.md", roots, "agent file")).toBe(
      path.resolve("/home/u/.claude/agents/reviewer.md")
    );
    expect(assertDirectChildOfRoots("/project/.agents/skills/my-skill", roots, "skill directory")).toBe(
      path.resolve("/project/.agents/skills/my-skill")
    );
  });

  it("normalizes .. segments before checking containment", () => {
    expect(() =>
      assertDirectChildOfRoots("/home/u/.claude/agents/../../.ssh/authorized_keys", roots, "agent file")
    ).toThrow(/outside the library directories/i);
  });

  it("rejects paths outside every root", () => {
    expect(() => assertDirectChildOfRoots("/etc/passwd", roots, "agent file")).toThrow(
      /outside the library directories/i
    );
    expect(() => assertDirectChildOfRoots("/project/src/index.ts", roots, "skill directory")).toThrow(
      /outside the library directories/i
    );
  });

  it("rejects the root itself and nested grandchildren", () => {
    expect(() => assertDirectChildOfRoots("/home/u/.claude/agents", roots, "agent file")).toThrow(
      /outside the library directories/i
    );
    expect(() =>
      assertDirectChildOfRoots("/project/.agents/skills/my-skill/nested", roots, "skill directory")
    ).toThrow(/outside the library directories/i);
  });

  it("still accepts a direct child reached through a redundant traversal", () => {
    expect(
      assertDirectChildOfRoots("/project/.agents/skills/../skills/my-skill", roots, "skill directory")
    ).toBe(path.resolve("/project/.agents/skills/my-skill"));
  });
});
