// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";

vi.mock("fs");
vi.mock("os");

import * as fs from "fs";
import * as os from "os";
import { readAgentFileSystemPrompt } from "./claude";

// ─── readAgentFileSystemPrompt ────────────────────────────────────────────────

describe("readAgentFileSystemPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue("/home/user");
  });

  it("returns null when the file does not exist", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(readAgentFileSystemPrompt("haiku-agent")).toBeNull();
  });

  it("returns the full content as body when there is no frontmatter", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("You only respond in haiku poems.");

    const result = readAgentFileSystemPrompt("haiku-agent");
    expect(result).toEqual({ body: "You only respond in haiku poems.", model: undefined });
  });

  it("parses body from frontmatter file without a model field", () => {
    const content = `---\nname: haiku-agent\ndescription: Responds in haiku\n---\n\nYou only respond in haiku poems.`;
    vi.mocked(fs.readFileSync).mockReturnValue(content);

    const result = readAgentFileSystemPrompt("haiku-agent");
    expect(result).toEqual({ body: "You only respond in haiku poems.", model: undefined });
  });

  it("parses body and model from frontmatter", () => {
    const content = `---\nname: haiku-agent\nmodel: claude-haiku-4-5\n---\n\nYou only respond in haiku poems.`;
    vi.mocked(fs.readFileSync).mockReturnValue(content);

    const result = readAgentFileSystemPrompt("haiku-agent");
    expect(result).toEqual({ body: "You only respond in haiku poems.", model: "claude-haiku-4-5" });
  });

  it("strips surrounding quotes from model value", () => {
    const content = `---\nname: haiku-agent\nmodel: 'claude-haiku-4-5'\n---\n\nBody.`;
    vi.mocked(fs.readFileSync).mockReturnValue(content);

    const result = readAgentFileSystemPrompt("haiku-agent");
    expect(result?.model).toBe("claude-haiku-4-5");
  });

  it("strips double quotes from model value", () => {
    const content = `---\nname: haiku-agent\nmodel: "claude-haiku-4-5"\n---\n\nBody.`;
    vi.mocked(fs.readFileSync).mockReturnValue(content);

    expect(readAgentFileSystemPrompt("haiku-agent")?.model).toBe("claude-haiku-4-5");
  });

  it("returns empty string body when there is nothing after the closing ---", () => {
    const content = `---\nname: haiku-agent\n---\n`;
    vi.mocked(fs.readFileSync).mockReturnValue(content);

    const result = readAgentFileSystemPrompt("haiku-agent");
    expect(result).toEqual({ body: "", model: undefined });
  });

  it("handles CRLF line endings in frontmatter", () => {
    const content = "---\r\nname: haiku-agent\r\nmodel: claude-haiku-4-5\r\n---\r\nYou only respond in haiku poems.";
    vi.mocked(fs.readFileSync).mockReturnValue(content);

    const result = readAgentFileSystemPrompt("haiku-agent");
    expect(result?.body).toBe("You only respond in haiku poems.");
    expect(result?.model).toBe("claude-haiku-4-5");
  });

  it("reads from the correct path based on the agent name", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("Body.");

    readAgentFileSystemPrompt("my-custom-agent");

    expect(fs.readFileSync).toHaveBeenCalledWith(
      path.join("/home/user", ".claude", "agents", "my-custom-agent.md"),
      "utf8"
    );
  });
});
