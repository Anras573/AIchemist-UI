// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseAgentMarkdown } from "./agent-file";

describe("parseAgentMarkdown", () => {
  it("parses name, description, model and body", () => {
    const parsed = parseAgentMarkdown(
      "---\nname: my-agent\ndescription: Does things\nmodel: claude-sonnet-4-6\n---\nSystem prompt here.\n"
    );
    expect(parsed).toEqual({
      name: "my-agent",
      description: "Does things",
      model: "claude-sonnet-4-6",
      body: "System prompt here.",
    });
  });

  it("returns null when there is no frontmatter block", () => {
    expect(parseAgentMarkdown("Just a prompt, no frontmatter.")).toBeNull();
  });

  it("strips surrounding quotes from field values", () => {
    const parsed = parseAgentMarkdown('---\nname: "quoted"\ndescription: \'also quoted\'\n---\nbody');
    expect(parsed?.name).toBe("quoted");
    expect(parsed?.description).toBe("also quoted");
  });

  it("defaults description to empty and omits model when absent", () => {
    const parsed = parseAgentMarkdown("---\nname: minimal\n---\nbody");
    expect(parsed).toEqual({ name: "minimal", description: "", body: "body" });
    expect(parsed && "model" in parsed).toBe(false);
  });

  it("returns null name when the name field is missing", () => {
    const parsed = parseAgentMarkdown("---\ndescription: anonymous\n---\nbody");
    expect(parsed?.name).toBeNull();
    expect(parsed?.body).toBe("body");
  });

  it("handles CRLF line endings", () => {
    const parsed = parseAgentMarkdown("---\r\nname: crlf\r\ndescription: windows\r\n---\r\nline one\r\nline two");
    expect(parsed?.name).toBe("crlf");
    expect(parsed?.body).toBe("line one\r\nline two");
  });

  it("returns an empty body when the file is frontmatter-only", () => {
    const parsed = parseAgentMarkdown("---\nname: empty-body\n---\n");
    expect(parsed?.body).toBe("");
  });
});
