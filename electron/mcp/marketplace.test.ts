// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { listMarketplaceEntries } from "./marketplace";
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
