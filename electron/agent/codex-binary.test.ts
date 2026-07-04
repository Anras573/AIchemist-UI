// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { codexTargetTriple, resolveCodexBinary } from "./codex-binary";

describe("codexTargetTriple", () => {
  it("maps supported platform/arch pairs", () => {
    expect(codexTargetTriple("linux", "x64")).toBe("x86_64-unknown-linux-musl");
    expect(codexTargetTriple("linux", "arm64")).toBe("aarch64-unknown-linux-musl");
    expect(codexTargetTriple("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(codexTargetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(codexTargetTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(codexTargetTriple("win32", "arm64")).toBe("aarch64-pc-windows-msvc");
  });

  it("returns null for unsupported platform/arch", () => {
    expect(codexTargetTriple("linux", "ia32")).toBeNull();
    expect(codexTargetTriple("freebsd", "x64")).toBeNull();
    expect(codexTargetTriple("darwin", "ppc")).toBeNull();
    // Android is not a desktop target — unsupported, unlike the SDK's resolver.
    expect(codexTargetTriple("android", "x64")).toBeNull();
  });
});

describe("resolveCodexBinary", () => {
  const savedOverride = process.env.CODEX_CLI_PATH;
  afterEach(() => {
    if (savedOverride === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = savedOverride;
  });

  it("honors the CODEX_CLI_PATH override without touching the filesystem", () => {
    process.env.CODEX_CLI_PATH = "/custom/path/codex";
    expect(resolveCodexBinary()).toEqual({ executablePath: "/custom/path/codex", pathDirs: [] });
  });

  it("resolves the bundled binary in this environment when supported", () => {
    delete process.env.CODEX_CLI_PATH;
    const supported = codexTargetTriple(process.platform, process.arch) !== null;
    const resolved = resolveCodexBinary();
    if (!supported) {
      // Nothing to assert on an unsupported host — the caller falls back to exec.
      expect(resolved).toBeNull();
      return;
    }
    // The platform-matched @openai/codex-<platform> optional dep is installed, so
    // the bundled binary must resolve to a real executable file.
    expect(resolved).not.toBeNull();
    expect(resolved!.executablePath).toMatch(/codex(\.exe)?$/);
    expect(fs.existsSync(resolved!.executablePath)).toBe(true);
  });
});
