// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Database } from "better-sqlite3";
import { getProjectConfig } from "./projects";
import type { ProjectConfig } from "../src/types/index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultConfig(): ProjectConfig {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    approval_mode: "custom",
    approval_rules: [
      { tool_category: "filesystem", policy: "risky_only" },
      { tool_category: "shell", policy: "always" },
      { tool_category: "web", policy: "never" },
    ],
    custom_tools: [],
    allowed_tools: [],
  };
}

/**
 * Minimal DB mock: prepare().get() returns { path: projectPath }.
 */
function makeDbForPath(projectPath: string): Database {
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ path: projectPath }),
    }),
  } as unknown as Database;
}

function makeDbProjectNotFound(): Database {
  return {
    prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
  } as unknown as Database;
}

function writeConfig(projectPath: string, data: unknown): void {
  const dir = path.join(projectPath, ".aichemist");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(data), "utf-8");
}

// ─── getProjectConfig — Zod validation ───────────────────────────────────────

describe("getProjectConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aichemist-test-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("throws when the project is not in the DB", () => {
    expect(() => getProjectConfig(makeDbProjectNotFound(), "ghost-id")).toThrow(
      "Project not found: ghost-id"
    );
  });

  it("creates and returns default config when no config file exists", () => {
    const db = makeDbForPath(tmpDir);
    const config = getProjectConfig(db, "proj-1");
    expect(config.provider).toBe("anthropic");
    expect(config.approval_mode).toBe("custom");
    // File should have been created
    expect(fs.existsSync(path.join(tmpDir, ".aichemist", "config.json"))).toBe(true);
  });

  it("returns a valid stored config", () => {
    writeConfig(tmpDir, {
      provider: "github",
      model: "gpt-4o",
      approval_mode: "none",
      approval_rules: [],
      custom_tools: [],
      allowed_tools: [],
    });
    const config = getProjectConfig(makeDbForPath(tmpDir), "proj-1");
    expect(config.provider).toBe("github");
    expect(config.model).toBe("gpt-4o");
    expect(config.approval_mode).toBe("none");
  });

  it("falls back to defaults when config JSON is corrupt", () => {
    const cfgPath = path.join(tmpDir, ".aichemist", "config.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, "{ not valid json !!!", "utf-8");

    const config = getProjectConfig(makeDbForPath(tmpDir), "proj-1");
    expect(config.provider).toBe("anthropic");
  });

  it("falls back to defaults and warns when approval_mode is invalid", () => {
    writeConfig(tmpDir, {
      ...defaultConfig(),
      approval_mode: "INVALID",
    });

    const config = getProjectConfig(makeDbForPath(tmpDir), "proj-1");
    expect(config.approval_mode).toBe("custom");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[projects]"),
      expect.anything()
    );
  });

  it("strips unknown extra fields from config", () => {
    writeConfig(tmpDir, {
      ...defaultConfig(),
      unknownField: "should be stripped",
    });

    const config = getProjectConfig(makeDbForPath(tmpDir), "proj-1") as unknown as Record<string, unknown>;
    expect(config["unknownField"]).toBeUndefined();
  });

  it("preserves acp_agent config across save/load (regression: #4)", () => {
    writeConfig(tmpDir, {
      ...defaultConfig(),
      provider: "acp",
      acp_agent: {
        command: "bun",
        args: ["run", "/path/to/mock-acp-agent.ts"],
        env: { CLAUDE_CODE_USE_BEDROCK: "1" },
        cwd: "/some/path",
        auth_method_id: "method-1",
      },
    });

    const config = getProjectConfig(makeDbForPath(tmpDir), "proj-1");
    expect(config.acp_agent).toEqual({
      command: "bun",
      args: ["run", "/path/to/mock-acp-agent.ts"],
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      cwd: "/some/path",
      auth_method_id: "method-1",
    });
  });

  it("accepts acp_agent with only the required command field", () => {
    writeConfig(tmpDir, {
      ...defaultConfig(),
      provider: "acp",
      acp_agent: { command: "my-agent" },
    });

    const config = getProjectConfig(makeDbForPath(tmpDir), "proj-1");
    expect(config.acp_agent).toEqual({ command: "my-agent" });
  });
});
