// @vitest-environment node
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Control the Claude agent-file fallback without touching ~/.claude/agents.
const agentFileMock = vi.hoisted(() => ({ result: null as { body: string; model?: string } | null }));
vi.mock("./claude", () => ({
  readAgentFileSystemPrompt: vi.fn(() => agentFileMock.result),
}));

import { composeCopilotSystemMessage, resolveSelectedAgent } from "./copilot";

const tempProjects: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".copilot-provider-"));
  tempProjects.push(dir);
  return dir;
}

/** Write a project-local Copilot agent file. */
function writeCopilotAgent(projectPath: string, name: string, frontmatter: string, body: string): void {
  const dir = path.join(projectPath, ".agents", "copilot-agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}`);
}

describe("copilot resolveSelectedAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentFileMock.result = null;
  });

  afterEach(() => {
    while (tempProjects.length > 0) {
      fs.rmSync(tempProjects.pop()!, { recursive: true, force: true });
    }
  });

  it("returns the body and model: override from a project-local Copilot agent", () => {
    const projectPath = makeTempProject();
    writeCopilotAgent(projectPath, "coder", "name: coder\nmodel: gpt-4o", "Be a careful coder.");

    expect(resolveSelectedAgent("coder", projectPath)).toEqual({
      body: "Be a careful coder.",
      model: "gpt-4o",
    });
  });

  it("returns an undefined model when the Copilot agent omits model:", () => {
    const projectPath = makeTempProject();
    writeCopilotAgent(projectPath, "coder", "name: coder", "Be a careful coder.");

    expect(resolveSelectedAgent("coder", projectPath)).toEqual({
      body: "Be a careful coder.",
      model: undefined,
    });
  });

  it("falls back to the Claude agent file (body + model) when no Copilot agent exists", () => {
    const projectPath = makeTempProject();
    agentFileMock.result = { body: "Claude agent body.", model: "claude-haiku-4-5" };

    expect(resolveSelectedAgent("haiku-agent", projectPath)).toEqual({
      body: "Claude agent body.",
      model: "claude-haiku-4-5",
    });
  });

  it("returns a null body when the agent is not found in either location", () => {
    const projectPath = makeTempProject();
    expect(resolveSelectedAgent("ghost", projectPath)).toEqual({ body: null, model: undefined });
  });
});

describe("composeCopilotSystemMessage", () => {
  const MEMORY_BLOCK = "\n\n---\n# Project Memory\n\n## Memory: notes.md\n\nuse bun";

  it("uses replace mode and includes agent body, skills, and memory when an agent body is set", () => {
    const { content, mode } = composeCopilotSystemMessage({
      agentBody: "Be a careful coder.",
      skillsContext: "\n\n## Skill: lint",
      memoryContext: MEMORY_BLOCK,
    });

    expect(mode).toBe("replace");
    expect(content).toContain("Be a careful coder.");
    expect(content).toContain("## Skill: lint");
    expect(content).toContain(MEMORY_BLOCK);
    // Memory + ask_user tool guidance are always present.
    expect(content).toContain("write_memory");
    expect(content).toContain("ask_user");
    // The agent body leads, the saved-notes block trails.
    expect(content.indexOf("Be a careful coder.")).toBeLessThan(content.indexOf(MEMORY_BLOCK));
  });

  it("uses append mode and omits skills (those go via customAgents) when no agent body is set", () => {
    const { content, mode } = composeCopilotSystemMessage({
      agentBody: null,
      skillsContext: "\n\n## Skill: lint",
      memoryContext: MEMORY_BLOCK,
    });

    expect(mode).toBe("append");
    expect(content).not.toContain("## Skill: lint");
    expect(content).toContain(MEMORY_BLOCK);
    expect(content).toContain("write_memory");
    expect(content).toContain("ask_user");
  });

  it("still mentions the memory tools even when no notes have been saved yet", () => {
    const { content } = composeCopilotSystemMessage({
      agentBody: null,
      skillsContext: "",
      memoryContext: "",
    });

    // The saved-notes block is empty, but the standing instruction must remain so
    // the model knows it can start persisting memory.
    expect(content).toContain("write_memory");
    expect(content).toContain("read_memory");
    expect(content).toContain("delete_memory");
  });

  it("drops tool guidance but keeps the read-only memory block in noTools turns", () => {
    const { content } = composeCopilotSystemMessage({
      agentBody: null,
      skillsContext: "",
      memoryContext: MEMORY_BLOCK,
      noTools: true,
    });

    // Text-only generation turns have no tools, so don't tell the model to call
    // them — but the saved notes are still useful context.
    expect(content).not.toContain("write_memory");
    expect(content).not.toContain("ask_user");
    expect(content).toContain(MEMORY_BLOCK);
  });
});
