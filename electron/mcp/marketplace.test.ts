// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listMarketplaceEntries,
  getMarketplaceEntry,
  missingRequiredFields,
  buildServerEntry,
  type MarketplaceEntry,
} from "./marketplace";
import { MARKETPLACE_CATALOG } from "./marketplace-catalog";

vi.mock("fs");
vi.mock("os", () => ({
  default: { homedir: () => "/home/user" },
  homedir: () => "/home/user",
}));

import * as fs from "fs";

let files: Record<string, string>;

const n = (p: fs.PathOrFileDescriptor) => String(p).replace(/\\/g, "/");

beforeEach(() => {
  files = {};
  vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
    const key = n(p);
    if (!(key in files)) {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return files[key];
  });
  vi.mocked(fs.writeFileSync).mockImplementation((p, data) => {
    files[n(p)] = String(data);
  });
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
});

describe("listMarketplaceEntries", () => {
  it("returns every catalog entry with installed: false when nothing is configured", () => {
    const list = listMarketplaceEntries();
    expect(list).toHaveLength(MARKETPLACE_CATALOG.length);
    expect(list.every((e) => e.installed === false)).toBe(true);
  });

  it("flags an entry installed when its id is a key in ~/.aichemist/mcp.json", () => {
    files["/home/user/.aichemist/mcp.json"] = JSON.stringify({
      mcpServers: { memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } },
    });
    const list = listMarketplaceEntries();
    const memory = list.find((e) => e.id === "memory");
    const filesystem = list.find((e) => e.id === "filesystem");
    expect(memory?.installed).toBe(true);
    expect(filesystem?.installed).toBe(false);
  });

  it("preserves all other entry fields verbatim", () => {
    const list = listMarketplaceEntries();
    const github = list.find((e) => e.id === "github");
    expect(github).toMatchObject({
      name: "GitHub",
      transport: "stdio",
      command: "npx",
    });
  });
});

describe("getMarketplaceEntry", () => {
  it("returns the matching entry by id", () => {
    expect(getMarketplaceEntry("github")?.name).toBe("GitHub");
  });

  it("returns undefined for an unknown id", () => {
    expect(getMarketplaceEntry("does-not-exist")).toBeUndefined();
  });
});

describe("missingRequiredFields", () => {
  const entry: MarketplaceEntry = {
    id: "test",
    name: "Test",
    description: "",
    transport: "stdio",
    command: "npx",
    args: ["{{token}}"],
    configFields: [
      { key: "token", label: "Token", required: true },
      { key: "optional", label: "Optional", required: false },
    ],
  };

  it("flags a required field that is absent", () => {
    expect(missingRequiredFields(entry, {}).map((f) => f.key)).toEqual(["token"]);
  });

  it("flags a required field that is present but blank", () => {
    expect(missingRequiredFields(entry, { token: "   " }).map((f) => f.key)).toEqual(["token"]);
  });

  it("does not flag an optional field", () => {
    expect(missingRequiredFields(entry, { token: "abc" })).toEqual([]);
  });

  it("returns [] for an entry with no configFields", () => {
    expect(missingRequiredFields({ ...entry, configFields: undefined }, {})).toEqual([]);
  });
});

describe("buildServerEntry", () => {
  it("substitutes {{token}} placeholders in command, args, and env", () => {
    const entry: MarketplaceEntry = {
      id: "github",
      name: "GitHub",
      description: "",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{githubToken}}" },
      configFields: [{ key: "githubToken", label: "Token", required: true }],
    };
    const result = buildServerEntry(entry, { githubToken: "secret-value" });
    expect(result).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "secret-value" },
    });
  });

  it("substitutes a placeholder inside an arg (not just whole-arg)", () => {
    const entry: MarketplaceEntry = {
      id: "filesystem",
      name: "Filesystem",
      description: "",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "{{rootPath}}"],
      configFields: [{ key: "rootPath", label: "Root", required: true }],
    };
    const result = buildServerEntry(entry, { rootPath: "/Users/me/projects" });
    expect(result.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/Users/me/projects",
    ]);
  });

  it("substitutes into url and headers for non-stdio entries", () => {
    const entry: MarketplaceEntry = {
      id: "remote",
      name: "Remote",
      description: "",
      transport: "http",
      url: "https://{{host}}/mcp",
      headers: { Authorization: "Bearer {{apiKey}}" },
      configFields: [{ key: "host", label: "Host", required: true }, { key: "apiKey", label: "Key", required: true }],
    };
    const result = buildServerEntry(entry, { host: "example.com", apiKey: "xyz" });
    expect(result).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer xyz" },
    });
  });

  it("substitutes an unresolved placeholder to an empty string", () => {
    const entry: MarketplaceEntry = {
      id: "test",
      name: "Test",
      description: "",
      transport: "stdio",
      command: "npx",
      args: ["{{missing}}"],
    };
    expect(buildServerEntry(entry, {}).args).toEqual([""]);
  });

  it("round-trips every real catalog entry without throwing", () => {
    for (const entry of MARKETPLACE_CATALOG) {
      const values = Object.fromEntries((entry.configFields ?? []).map((f) => [f.key, "test-value"]));
      const result = buildServerEntry(entry, values);
      expect(result.type).toBe(entry.transport);
      expect(JSON.stringify(result)).not.toContain("{{");
    }
  });
});

describe("MARKETPLACE_CATALOG", () => {
  it("has no duplicate ids", () => {
    const ids = MARKETPLACE_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every configField key is referenced by a {{token}} placeholder somewhere in the entry", () => {
    for (const entry of MARKETPLACE_CATALOG) {
      const haystack = JSON.stringify({
        command: entry.command,
        args: entry.args,
        env: entry.env,
        url: entry.url,
        headers: entry.headers,
      });
      for (const field of entry.configFields ?? []) {
        expect(haystack).toContain(`{{${field.key}}}`);
      }
    }
  });

  it("stdio entries declare a command, non-stdio entries declare a url", () => {
    for (const entry of MARKETPLACE_CATALOG) {
      if (entry.transport === "stdio") {
        expect(entry.command).toBeTruthy();
      } else {
        expect(entry.url).toBeTruthy();
      }
    }
  });
});
