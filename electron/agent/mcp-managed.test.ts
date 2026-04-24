// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadManagedMcpServers,
  toClaudeMcpServers,
  toCopilotMcpServers,
  fingerprintManaged,
  RESERVED_MCP_NAME,
} from "./mcp-managed";

vi.mock("fs");
vi.mock("os", () => ({
  default: { homedir: () => "/home/user" },
  homedir: () => "/home/user",
}));

import * as fs from "fs";

let files: Record<string, string>;

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

describe("loadManagedMcpServers", () => {
  it("returns empty map when the file is missing", () => {
    expect(loadManagedMcpServers()).toEqual({});
  });

  it("reads servers from ~/.aichemist/mcp.json", () => {
    files["/home/user/.aichemist/mcp.json"] = JSON.stringify({
      mcpServers: {
        echo: { command: "node", args: ["echo.js"] },
        api: { url: "https://api.example.com/mcp" },
      },
    });
    expect(loadManagedMcpServers()).toEqual({
      echo: { command: "node", args: ["echo.js"] },
      api: { url: "https://api.example.com/mcp" },
    });
  });

  it("strips the reserved aichemist-tools name defensively", () => {
    files["/home/user/.aichemist/mcp.json"] = JSON.stringify({
      mcpServers: {
        [RESERVED_MCP_NAME]: { command: "evil" },
        good: { command: "good" },
      },
    });
    const result = loadManagedMcpServers();
    expect(result).toEqual({ good: { command: "good" } });
    expect(RESERVED_MCP_NAME in result).toBe(false);
  });

  it("excludes names listed in opts.excludeNames", () => {
    files["/home/user/.aichemist/mcp.json"] = JSON.stringify({
      mcpServers: {
        a: { command: "a" },
        b: { command: "b" },
        c: { command: "c" },
      },
    });
    const result = loadManagedMcpServers({ excludeNames: new Set(["b"]) });
    expect(result).toEqual({ a: { command: "a" }, c: { command: "c" } });
  });

  it("excludeNames + reserved name strip stack correctly", () => {
    files["/home/user/.aichemist/mcp.json"] = JSON.stringify({
      mcpServers: {
        [RESERVED_MCP_NAME]: { command: "x" },
        a: { command: "a" },
        b: { command: "b" },
      },
    });
    const result = loadManagedMcpServers({ excludeNames: new Set(["a"]) });
    expect(result).toEqual({ b: { command: "b" } });
  });
});

describe("toClaudeMcpServers", () => {
  it("passes entries through verbatim", () => {
    expect(
      toClaudeMcpServers({
        a: { command: "a", args: ["1"] },
        b: { url: "https://b", headers: { Auth: "x" } },
      }),
    ).toEqual({
      a: { command: "a", args: ["1"] },
      b: { url: "https://b", headers: { Auth: "x" } },
    });
  });

  it("filters out the reserved name", () => {
    expect(
      toClaudeMcpServers({
        [RESERVED_MCP_NAME]: { command: "x" },
        good: { command: "good" },
      }),
    ).toEqual({ good: { command: "good" } });
  });
});

describe("toCopilotMcpServers", () => {
  it("converts a stdio entry to MCPLocalServerConfig with tools=['*']", () => {
    expect(
      toCopilotMcpServers({
        echo: { command: "node", args: ["echo.js"], env: { K: "v" } },
      }),
    ).toEqual({
      echo: { type: "local", command: "node", args: ["echo.js"], env: { K: "v" }, tools: ["*"] },
    });
  });

  it("infers http transport when url is present without explicit type", () => {
    expect(
      toCopilotMcpServers({
        api: { url: "https://api/mcp", headers: { A: "1" } },
      }),
    ).toEqual({
      api: { type: "http", url: "https://api/mcp", headers: { A: "1" }, tools: ["*"] },
    });
  });

  it("respects explicit sse type", () => {
    expect(toCopilotMcpServers({ s: { type: "sse", url: "https://s" } })).toEqual({
      s: { type: "sse", url: "https://s", tools: ["*"] },
    });
  });

  it("respects explicit stdio type even when url present (defensive)", () => {
    // Edge case: type=stdio wins over url. This is unusual but valid input.
    expect(
      toCopilotMcpServers({ s: { type: "stdio", command: "x", url: "ignored" } }),
    ).toEqual({
      s: { type: "local", command: "x", args: [], tools: ["*"] },
    });
  });

  it("preserves a user-specified tools allow-list", () => {
    expect(
      toCopilotMcpServers({
        echo: { command: "x", tools: ["only_this"] } as never,
      }),
    ).toEqual({
      echo: { type: "local", command: "x", args: [], tools: ["only_this"] },
    });
  });

  it("filters out the reserved name", () => {
    expect(
      toCopilotMcpServers({
        [RESERVED_MCP_NAME]: { command: "x" },
        good: { command: "good" },
      }),
    ).toMatchObject({ good: { type: "local" } });
  });

  it("defaults missing args to []", () => {
    expect(toCopilotMcpServers({ x: { command: "x" } })).toEqual({
      x: { type: "local", command: "x", args: [], tools: ["*"] },
    });
  });
});

describe("fingerprintManaged", () => {
  it("returns null for an empty map", () => {
    expect(fingerprintManaged({})).toBeNull();
  });

  it("ignores the reserved name", () => {
    expect(fingerprintManaged({ [RESERVED_MCP_NAME]: { command: "x" } })).toBeNull();
  });

  it("is stable regardless of key order", () => {
    const a = { foo: { command: "x", args: ["1"] }, bar: { url: "https://y" } };
    const b = { bar: { url: "https://y" }, foo: { args: ["1"], command: "x" } };
    expect(fingerprintManaged(a)).toBe(fingerprintManaged(b));
  });

  it("changes when an entry's content changes", () => {
    const a = fingerprintManaged({ foo: { command: "x" } });
    const b = fingerprintManaged({ foo: { command: "y" } });
    expect(a).not.toBe(b);
  });

  it("changes when an entry is added", () => {
    const a = fingerprintManaged({ foo: { command: "x" } });
    const b = fingerprintManaged({ foo: { command: "x" }, bar: { command: "y" } });
    expect(a).not.toBe(b);
  });
});
