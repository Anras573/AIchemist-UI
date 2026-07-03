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
    create_worktree_per_session: false,
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
    expect(config.create_worktree_per_session).toBe(false);
    // File should have been created
    expect(fs.existsSync(path.join(tmpDir, ".aichemist", "config.json"))).toBe(true);
  });

  it("returns a valid stored config", () => {
    writeConfig(tmpDir, {
      provider: "copilot",
      model: "gpt-4o",
      approval_mode: "none",
      approval_rules: [],
      custom_tools: [],
      allowed_tools: [],
    });
    const config = getProjectConfig(makeDbForPath(tmpDir), "proj-1");
    expect(config.provider).toBe("copilot");
    expect(config.model).toBe("gpt-4o");
    expect(config.approval_mode).toBe("none");
  });

  it("falls back to defaults when provider is not a valid enum value", () => {
    writeConfig(tmpDir, {
      ...defaultConfig(),
      provider: "github",
    });

    const config = getProjectConfig(makeDbForPath(tmpDir), "proj-1");
    expect(config.provider).toBe("anthropic");
    const warnSpy = vi.mocked(console.warn);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, json] = warnSpy.mock.calls[0];
    expect(msg).toContain("[projects]");
    const payload = JSON.parse(json as string) as {
      configPath: string;
      issues: Array<{ actual: unknown; expected: unknown }>;
    };
    expect(payload.configPath).toBe(path.join(tmpDir, ".aichemist", "config.json"));
    expect(payload.issues).toHaveLength(1);
    expect(payload.issues[0].actual).toBe("github");
    expect(payload.issues[0].expected).toEqual(
      expect.arrayContaining(["anthropic", "copilot", "ollama", "openai-compatible", "codex"])
    );
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
    const warnSpy = vi.mocked(console.warn);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, json] = warnSpy.mock.calls[0];
    expect(msg).toContain("[projects]");
    const payload = JSON.parse(json as string) as {
      issues: Array<{ path: string; actual: unknown; expected: unknown }>;
    };
    expect(payload.issues).toHaveLength(1);
    expect(payload.issues[0].path).toBe("approval_mode");
    expect(payload.issues[0].actual).toBe("INVALID");
    expect(payload.issues[0].expected).toEqual(
      expect.arrayContaining(["all", "none", "custom"])
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

});
