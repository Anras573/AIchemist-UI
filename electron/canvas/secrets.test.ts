import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  _setCanvasSecretsPathForTests,
  clearCanvasSecret,
  getCanvasSecretStatus,
  resolveSecretEnv,
  secretScopeKey,
  setCanvasSecret,
} from "./secrets";
import { buildHostEnv } from "./host-manager";

let dir: string;
const declared = [{ name: "GITHUB_TOKEN", description: "PAT" }];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-secrets-"));
  _setCanvasSecretsPathForTests(path.join(dir, "canvas-secrets.json"));
});
afterEach(() => {
  _setCanvasSecretsPathForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("canvas secrets", () => {
  it("injects a declared secret only into the definition that has it", () => {
    setCanvasSecret("board", declared, "GITHUB_TOKEN", "ghp_abc");
    expect(resolveSecretEnv("board", declared)).toEqual({ GITHUB_TOKEN: "ghp_abc" });
    // A second canvas that doesn't declare it — or has its own scope — sees nothing.
    expect(resolveSecretEnv("other", undefined)).toEqual({});
    expect(resolveSecretEnv("other", declared)).toEqual({});
    expect(resolveSecretEnv("board", [{ name: "OTHER" }])).toEqual({});
  });

  it("scopes project-tier definitions separately from global ones", () => {
    expect(secretScopeKey("global", "board", "p1")).toBe("board");
    expect(secretScopeKey("project", "board", "p1")).toBe("project:p1:board");
    setCanvasSecret("board", declared, "GITHUB_TOKEN", "ghp_abc");
    expect(resolveSecretEnv(secretScopeKey("project", "board", "p1"), declared)).toEqual({});
  });

  it("refuses undeclared names", () => {
    expect(() => setCanvasSecret("board", declared, "NOPE", "x")).toThrow(/not declared/);
  });

  it("reports status without values, and clears", () => {
    setCanvasSecret("board", declared, "GITHUB_TOKEN", "ghp_abc");
    const status = getCanvasSecretStatus("board", declared);
    expect(status).toEqual([{ name: "GITHUB_TOKEN", description: "PAT", set: true }]);
    expect(JSON.stringify(status)).not.toContain("ghp_abc");
    clearCanvasSecret("board", "GITHUB_TOKEN");
    expect(getCanvasSecretStatus("board", declared)[0].set).toBe(false);
  });

  it("writes the file with mode 0600", () => {
    setCanvasSecret("board", declared, "GITHUB_TOKEN", "ghp_abc");
    const mode = fs.statSync(path.join(dir, "canvas-secrets.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("still strips undeclared provider keys from the base host env", () => {
    const env = buildHostEnv({ GITHUB_TOKEN: "user-token", ANTHROPIC_API_KEY: "k", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});
