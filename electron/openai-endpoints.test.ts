// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setEndpointsPathForTests,
  deleteOpenAiEndpoint,
  formatCompositeModelId,
  getOpenAiEndpointsPath,
  isValidEndpointName,
  parseCompositeModelId,
  readOpenAiEndpoints,
  upsertOpenAiEndpoint,
  writeOpenAiEndpoints,
} from "./openai-endpoints";

// Windows (NTFS) does not model POSIX permission bits, so fs.chmod's 0o600 is a
// no-op there — fs.statSync reports 0o666 regardless. Skip the mode assertions
// on Windows; the owner-only-write guarantee only applies on POSIX filesystems.
const itPosix = process.platform === "win32" ? it.skip : it;

let tempDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-endpoints-"));
  configPath = path.join(tempDir, "openai-providers.json");
  _setEndpointsPathForTests(configPath);
});

afterEach(() => {
  _setEndpointsPathForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("openai-endpoints config", () => {
  it("returns an empty map when the file is missing", () => {
    expect(readOpenAiEndpoints()).toEqual({});
  });

  it("returns an empty map for malformed JSON", () => {
    fs.writeFileSync(configPath, "{not json");
    expect(readOpenAiEndpoints()).toEqual({});
  });

  it("rethrows real I/O errors (not ENOENT) so they can be surfaced", () => {
    // Point the path at a directory — reading it throws EISDIR, a real I/O
    // error that must not be masked as "no endpoints configured".
    const dirPath = path.join(tempDir, "is-a-dir");
    fs.mkdirSync(dirPath);
    _setEndpointsPathForTests(dirPath);
    expect(() => readOpenAiEndpoints()).toThrow();
  });

  it("round-trips endpoints through write and read", () => {
    writeOpenAiEndpoints({
      lmstudio: { baseURL: "http://localhost:1234/v1" },
      together: { baseURL: "https://api.together.xyz/v1", apiKey: "tok", headers: { "X-Custom": "1" } },
    });
    expect(readOpenAiEndpoints()).toEqual({
      lmstudio: { baseURL: "http://localhost:1234/v1" },
      together: { baseURL: "https://api.together.xyz/v1", apiKey: "tok", headers: { "X-Custom": "1" } },
    });
  });

  it("preserves unknown top-level keys in the JSON document", () => {
    fs.writeFileSync(configPath, JSON.stringify({ userNote: "keep me", endpoints: {} }));
    writeOpenAiEndpoints({ local: { baseURL: "http://localhost:8000/v1" } });
    const doc = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(doc.userNote).toBe("keep me");
    expect(doc.endpoints.local.baseURL).toBe("http://localhost:8000/v1");
  });

  itPosix("writes the file with owner-only permissions (may contain API keys)", () => {
    writeOpenAiEndpoints({ local: { baseURL: "http://localhost:8000/v1" } });
    const mode = fs.statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  itPosix("tightens permissions on a pre-existing file with broader mode", () => {
    fs.writeFileSync(configPath, JSON.stringify({ endpoints: {} }), { mode: 0o644 });
    writeOpenAiEndpoints({ local: { baseURL: "http://localhost:8000/v1" } });
    const mode = fs.statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("drops entries with invalid names or missing baseURL on read", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        endpoints: {
          good: { baseURL: "http://localhost:1234/v1" },
          "bad/name": { baseURL: "http://localhost:5678/v1" },
          "no-url": { apiKey: "x" },
          "bad-url": { baseURL: "ftp://nope" },
        },
      }),
    );
    expect(Object.keys(readOpenAiEndpoints())).toEqual(["good"]);
  });

  it("drops entries with malformed apiKey/headers/queryParams on read", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        endpoints: {
          good: { baseURL: "http://a/v1", apiKey: "tok", headers: { X: "1" } },
          "bad-key": { baseURL: "http://a/v1", apiKey: 123 },
          "bad-headers": { baseURL: "http://a/v1", headers: { X: 1 } },
          "headers-array": { baseURL: "http://a/v1", headers: ["nope"] },
          "bad-query": { baseURL: "http://a/v1", queryParams: { v: true } },
        },
      }),
    );
    expect(Object.keys(readOpenAiEndpoints())).toEqual(["good"]);
  });

  it("rejects writes with invalid endpoint names or baseURLs", () => {
    expect(() => writeOpenAiEndpoints({ "a/b": { baseURL: "http://x/v1" } })).toThrow(/Invalid endpoint name/);
    expect(() => writeOpenAiEndpoints({ ok: { baseURL: "not-a-url" } })).toThrow(/baseURL/);
  });

  it("rejects writes with malformed optional fields", () => {
    expect(() =>
      writeOpenAiEndpoints({ ok: { baseURL: "http://x/v1", apiKey: 5 as unknown as string } }),
    ).toThrow(/apiKey/);
    expect(() =>
      writeOpenAiEndpoints({ ok: { baseURL: "http://x/v1", headers: { X: 1 as unknown as string } } }),
    ).toThrow(/headers/);
  });

  it("upserts and deletes single endpoints", () => {
    upsertOpenAiEndpoint("a", { baseURL: "http://a/v1" });
    upsertOpenAiEndpoint("b", { baseURL: "http://b/v1" });
    upsertOpenAiEndpoint("a", { baseURL: "http://a2/v1" });
    expect(readOpenAiEndpoints()).toEqual({
      a: { baseURL: "http://a2/v1" },
      b: { baseURL: "http://b/v1" },
    });
    deleteOpenAiEndpoint("a");
    deleteOpenAiEndpoint("does-not-exist");
    expect(readOpenAiEndpoints()).toEqual({ b: { baseURL: "http://b/v1" } });
  });

  it("exposes the overridden path", () => {
    expect(getOpenAiEndpointsPath()).toBe(configPath);
  });
});

describe("endpoint names and composite model ids", () => {
  it("validates endpoint names", () => {
    expect(isValidEndpointName("lmstudio")).toBe(true);
    expect(isValidEndpointName("my.endpoint_2-x")).toBe(true);
    expect(isValidEndpointName("has/slash")).toBe(false);
    expect(isValidEndpointName("")).toBe(false);
    expect(isValidEndpointName("-leading")).toBe(false);
  });

  it("splits composite ids on the first slash so model ids may contain slashes", () => {
    expect(parseCompositeModelId("together/meta-llama/Llama-3-70b")).toEqual({
      endpointName: "together",
      modelId: "meta-llama/Llama-3-70b",
    });
    expect(parseCompositeModelId("lmstudio/qwen2.5")).toEqual({
      endpointName: "lmstudio",
      modelId: "qwen2.5",
    });
  });

  it("returns null for ids without a usable endpoint prefix", () => {
    expect(parseCompositeModelId("no-slash")).toBeNull();
    expect(parseCompositeModelId("/leading")).toBeNull();
    expect(parseCompositeModelId("trailing/")).toBeNull();
  });

  it("formats composite ids that parse back to the same parts", () => {
    const id = formatCompositeModelId("ep", "org/model:tag");
    expect(parseCompositeModelId(id)).toEqual({ endpointName: "ep", modelId: "org/model:tag" });
  });
});
