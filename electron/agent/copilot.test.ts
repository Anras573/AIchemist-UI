// @vitest-environment node
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Control the Claude agent-file fallback without touching ~/.claude/agents.
const agentFileMock = vi.hoisted(() => ({ result: null as { body: string; model?: string } | null }));
vi.mock("./claude", () => ({
  readAgentFileSystemPrompt: vi.fn(() => agentFileMock.result),
}));

import { resolveSelectedAgent } from "./copilot";

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
