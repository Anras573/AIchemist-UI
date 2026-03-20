import { describe, it, expect } from "vitest";
import { parseAgentFrontmatter } from "../../electron/agent/claude";

// ─── parseAgentFrontmatter ────────────────────────────────────────────────────

describe("parseAgentFrontmatter", () => {
  it("returns null when there is no frontmatter delimiter", () => {
    expect(parseAgentFrontmatter("Just some content with no frontmatter")).toBeNull();
  });

  it("returns null when the frontmatter has no name field", () => {
    const content = `---\ndescription: A helper\n---\nBody`;
    expect(parseAgentFrontmatter(content)).toBeNull();
  });

  it("parses name and description", () => {
    const content = `---\nname: research\ndescription: Searches the web\n---\nBody`;
    expect(parseAgentFrontmatter(content)).toEqual({
      name: "research",
      description: "Searches the web",
    });
  });

  it("parses name, description, and model", () => {
    const content = `---\nname: coder\ndescription: Writes code\nmodel: claude-opus-4-5\n---\nBody`;
    expect(parseAgentFrontmatter(content)).toEqual({
      name: "coder",
      description: "Writes code",
      model: "claude-opus-4-5",
    });
  });

  it("strips surrounding single quotes from field values", () => {
    const content = `---\nname: 'My Agent'\ndescription: 'Does things'\n---\nBody`;
    const result = parseAgentFrontmatter(content);
    expect(result?.name).toBe("My Agent");
    expect(result?.description).toBe("Does things");
  });

  it("strips surrounding double quotes from field values", () => {
    const content = `---\nname: "My Agent"\ndescription: "Does things"\n---\nBody`;
    const result = parseAgentFrontmatter(content);
    expect(result?.name).toBe("My Agent");
    expect(result?.description).toBe("Does things");
  });

  it("omits model when not present in frontmatter", () => {
    const content = `---\nname: helper\ndescription: Helps\n---\nBody`;
    const result = parseAgentFrontmatter(content);
    expect(result).not.toHaveProperty("model");
  });

  it("uses empty string for description when field is absent", () => {
    const content = `---\nname: minimal\n---\nBody`;
    const result = parseAgentFrontmatter(content);
    expect(result?.description).toBe("");
  });

  it("handles Windows-style CRLF line endings", () => {
    const content = `---\r\nname: agent\r\ndescription: Works\r\n---\r\nBody`;
    expect(parseAgentFrontmatter(content)).toEqual({
      name: "agent",
      description: "Works",
    });
  });

  it("parses a realistic .agent.md file from ~/.claude/agents/", () => {
    const content = `---
name: .NET Coding Agent
description: 'Expert .NET software engineer for C# development.'
model: Claude Opus 4.5
tools: ['vscode', 'execute', 'read']
---

You are an expert C#/.NET engineer...`;
    const result = parseAgentFrontmatter(content);
    expect(result?.name).toBe(".NET Coding Agent");
    expect(result?.description).toBe("Expert .NET software engineer for C# development.");
    expect(result?.model).toBe("Claude Opus 4.5");
  });
});
