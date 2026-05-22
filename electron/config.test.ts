// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkApiKeys, buildChildProcessPath } from "./config";

// ─── buildChildProcessPath ────────────────────────────────────────────────────

describe("buildChildProcessPath", () => {
  it("uses Unix delimiter when provided", () => {
    expect(buildChildProcessPath("/bin:/usr/bin", ":")).toBe(
      "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/bin"
    );
  });

  it("uses Windows delimiter when provided", () => {
    expect(buildChildProcessPath("C:\\Windows\\System32;C:\\Program Files\\Git\\cmd", ";")).toBe(
      "/opt/homebrew/bin;/opt/homebrew/sbin;/usr/local/bin;/usr/bin;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd"
    );
  });

  it("filters empty paths", () => {
    expect(buildChildProcessPath("", ":")).toBe(
      "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin"
    );
  });

  it("defaults to colon delimiter and process.env.PATH", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/some/path";
    try {
      const result = buildChildProcessPath();
      expect(result).toContain("/opt/homebrew/bin");
      expect(result).toContain("/some/path");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// ─── checkApiKeys ─────────────────────────────────────────────────────────────

describe("checkApiKeys", () => {
  // Snapshot and restore the env vars we touch so tests don't bleed into each other.
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (savedEnv.ANTHROPIC_API_KEY !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (savedEnv.ANTHROPIC_AUTH_TOKEN !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = savedEnv.ANTHROPIC_AUTH_TOKEN;
    } else {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
    if (savedEnv.GITHUB_TOKEN !== undefined) {
      process.env.GITHUB_TOKEN = savedEnv.GITHUB_TOKEN;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("returns both providers when no keys are set", () => {
    const missing = checkApiKeys();
    expect(missing).toContain("Anthropic");
    expect(missing).toContain("GitHub Copilot");
    expect(missing).toHaveLength(2);
  });

  it("omits Anthropic when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const missing = checkApiKeys();
    expect(missing).not.toContain("Anthropic");
    expect(missing).toContain("GitHub Copilot");
  });

  it("omits Anthropic when ANTHROPIC_AUTH_TOKEN is the fallback key", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-token";
    const missing = checkApiKeys();
    expect(missing).not.toContain("Anthropic");
  });

  it("omits GitHub Copilot when GITHUB_TOKEN is set", () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    const missing = checkApiKeys();
    expect(missing).not.toContain("GitHub Copilot");
    expect(missing).toContain("Anthropic");
  });

  it("returns empty array when both keys are set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.GITHUB_TOKEN = "ghp_test";
    expect(checkApiKeys()).toHaveLength(0);
  });

  it("treats empty string as missing", () => {
    process.env.ANTHROPIC_API_KEY = "";
    process.env.GITHUB_TOKEN = "";
    const missing = checkApiKeys();
    expect(missing).toContain("Anthropic");
    expect(missing).toContain("GitHub Copilot");
  });
});
