// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getConfigPath,
  readMcpServers,
  writeMcpServers,
  upsertMcpServer,
  deleteMcpServer,
} from "./mcp-config";

vi.mock("fs");
vi.mock("os", () => ({
  default: { homedir: () => "/home/user" },
  homedir: () => "/home/user",
}));

import * as fs from "fs";

type FakeFs = Record<string, string>;
let files: FakeFs;

beforeEach(() => {
  files = {};
  vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
    const key = String(p);
    if (!(key in files)) {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return files[key];
  });
  vi.mocked(fs.writeFileSync).mockImplementation((p, data) => {
    files[String(p)] = String(data);
  });
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
});

describe("getConfigPath", () => {
  it("resolves paths per scope", () => {
    expect(getConfigPath("claude-user")).toBe("/home/user/.claude.json");
    expect(getConfigPath("claude-local", "/proj")).toBe("/home/user/.claude.json");
    expect(getConfigPath("claude-project", "/proj")).toBe("/proj/.mcp.json");
    expect(getConfigPath("copilot-global")).toBe("/home/user/.copilot/mcp-config.json");
    expect(getConfigPath("aichemist-global")).toBe("/home/user/.aichemist/mcp.json");
  });

  it("throws when projectPath missing for project scope", () => {
    expect(() => getConfigPath("claude-project")).toThrow(/projectPath/);
  });
});

describe("readMcpServers", () => {
  it("returns empty map when file is missing", () => {
    expect(readMcpServers("claude-user")).toEqual({});
    expect(readMcpServers("copilot-global")).toEqual({});
  });

  it("reads claude-user mcpServers at document root", () => {
    files["/home/user/.claude.json"] = JSON.stringify({
      mcpServers: { foo: { command: "foo-cmd" } },
      other: "kept",
    });
    expect(readMcpServers("claude-user")).toEqual({ foo: { command: "foo-cmd" } });
  });

  it("reads claude-local from projects[path].mcpServers", () => {
    files["/home/user/.claude.json"] = JSON.stringify({
      projects: {
        "/proj": { mcpServers: { bar: { command: "bar-cmd" } }, allowedTools: [] },
        "/other": { mcpServers: { baz: {} } },
      },
    });
    expect(readMcpServers("claude-local", "/proj")).toEqual({ bar: { command: "bar-cmd" } });
  });

  it("reads claude-project from <projectPath>/.mcp.json", () => {
    files["/proj/.mcp.json"] = JSON.stringify({
      mcpServers: { p: { url: "https://x" } },
    });
    expect(readMcpServers("claude-project", "/proj")).toEqual({ p: { url: "https://x" } });
  });

  it("reads copilot-global", () => {
    files["/home/user/.copilot/mcp-config.json"] = JSON.stringify({
      mcpServers: { c: { command: "c" } },
    });
    expect(readMcpServers("copilot-global")).toEqual({ c: { command: "c" } });
  });

  it("reads aichemist-global", () => {
    files["/home/user/.aichemist/mcp.json"] = JSON.stringify({
      mcpServers: { custom: { command: "node", args: ["server.js"] } },
    });
    expect(readMcpServers("aichemist-global")).toEqual({
      custom: { command: "node", args: ["server.js"] },
    });
  });

  it("requires projectPath for local/project scopes", () => {
    expect(() => readMcpServers("claude-local")).toThrow(/projectPath/);
    expect(() => readMcpServers("claude-project")).toThrow(/projectPath/);
  });
});

describe("writeMcpServers", () => {
  it("preserves other keys in ~/.claude.json when writing claude-user", () => {
    files["/home/user/.claude.json"] = JSON.stringify({
      mcpServers: { old: { command: "old" } },
      numStartups: 42,
      projects: { "/proj": { allowedTools: ["Read"] } },
    });
    writeMcpServers("claude-user", { fresh: { command: "new" } });
    const doc = JSON.parse(files["/home/user/.claude.json"]);
    expect(doc.mcpServers).toEqual({ fresh: { command: "new" } });
    expect(doc.numStartups).toBe(42);
    expect(doc.projects).toEqual({ "/proj": { allowedTools: ["Read"] } });
  });

  it("preserves siblings of mcpServers inside projects[path] for claude-local", () => {
    files["/home/user/.claude.json"] = JSON.stringify({
      projects: {
        "/proj": { mcpServers: { a: {} }, allowedTools: ["Read"], customKey: true },
        "/other": { mcpServers: { keep: {} } },
      },
    });
    writeMcpServers("claude-local", { b: { command: "b" } }, "/proj");
    const doc = JSON.parse(files["/home/user/.claude.json"]);
    expect(doc.projects["/proj"]).toEqual({
      allowedTools: ["Read"],
      customKey: true,
      mcpServers: { b: { command: "b" } },
    });
    expect(doc.projects["/other"]).toEqual({ mcpServers: { keep: {} } });
  });

  it("creates the claude-local project entry when it doesn't exist yet", () => {
    files["/home/user/.claude.json"] = JSON.stringify({ numStartups: 1 });
    writeMcpServers("claude-local", { new: { command: "x" } }, "/brand-new");
    const doc = JSON.parse(files["/home/user/.claude.json"]);
    expect(doc.numStartups).toBe(1);
    expect(doc.projects["/brand-new"]).toEqual({ mcpServers: { new: { command: "x" } } });
  });

  it("writes .mcp.json for claude-project even when file doesn't exist", () => {
    writeMcpServers("claude-project", { s: { command: "s" } }, "/proj");
    const doc = JSON.parse(files["/proj/.mcp.json"]);
    expect(doc.mcpServers).toEqual({ s: { command: "s" } });
  });

  it("writes aichemist-global round-trip, preserving other keys", () => {
    files["/home/user/.aichemist/mcp.json"] = JSON.stringify({
      mcpServers: { old: { command: "old" } },
      version: 1,
    });
    writeMcpServers("aichemist-global", { fresh: { url: "https://x" } });
    const doc = JSON.parse(files["/home/user/.aichemist/mcp.json"]);
    expect(doc.mcpServers).toEqual({ fresh: { url: "https://x" } });
    expect(doc.version).toBe(1);
  });

  it("writes aichemist-global to a brand-new file", () => {
    writeMcpServers("aichemist-global", { a: { command: "a" } });
    const doc = JSON.parse(files["/home/user/.aichemist/mcp.json"]);
    expect(doc.mcpServers).toEqual({ a: { command: "a" } });
  });

  it("writes copilot-global, preserving other keys", () => {
    files["/home/user/.copilot/mcp-config.json"] = JSON.stringify({
      mcpServers: { x: {} },
      settings: { foo: "bar" },
    });
    writeMcpServers("copilot-global", { y: { url: "https://y" } });
    const doc = JSON.parse(files["/home/user/.copilot/mcp-config.json"]);
    expect(doc.mcpServers).toEqual({ y: { url: "https://y" } });
    expect(doc.settings).toEqual({ foo: "bar" });
  });
});

describe("upsertMcpServer / deleteMcpServer", () => {
  it("upsert adds a server and leaves others intact", () => {
    files["/proj/.mcp.json"] = JSON.stringify({
      mcpServers: { a: { command: "a" } },
    });
    upsertMcpServer("claude-project", "b", { command: "b" }, "/proj");
    const doc = JSON.parse(files["/proj/.mcp.json"]);
    expect(doc.mcpServers).toEqual({ a: { command: "a" }, b: { command: "b" } });
  });

  it("upsert overrides an existing server", () => {
    files["/proj/.mcp.json"] = JSON.stringify({
      mcpServers: { a: { command: "old" } },
    });
    upsertMcpServer("claude-project", "a", { command: "new", args: ["x"] }, "/proj");
    const doc = JSON.parse(files["/proj/.mcp.json"]);
    expect(doc.mcpServers.a).toEqual({ command: "new", args: ["x"] });
  });

  it("delete removes a server", () => {
    files["/proj/.mcp.json"] = JSON.stringify({
      mcpServers: { a: { command: "a" }, b: { command: "b" } },
    });
    deleteMcpServer("claude-project", "a", "/proj");
    const doc = JSON.parse(files["/proj/.mcp.json"]);
    expect(doc.mcpServers).toEqual({ b: { command: "b" } });
  });

  it("delete is a no-op when the server doesn't exist", () => {
    files["/proj/.mcp.json"] = JSON.stringify({
      mcpServers: { a: { command: "a" } },
    });
    deleteMcpServer("claude-project", "does-not-exist", "/proj");
    const doc = JSON.parse(files["/proj/.mcp.json"]);
    expect(doc.mcpServers).toEqual({ a: { command: "a" } });
  });
});
