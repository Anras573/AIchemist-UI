// @vitest-environment node
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { agentFilePathFor, assertSafeName, skillPathFor } from "./library-handlers";

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
