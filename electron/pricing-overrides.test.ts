// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setPricingOverridesPathForTests,
  deletePricingOverride,
  getPricingOverridesPath,
  overrideKey,
  readPricingOverrides,
  upsertPricingOverride,
  writePricingOverrides,
} from "./pricing-overrides";

let tempDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-overrides-"));
  configPath = path.join(tempDir, "pricing-overrides.json");
  _setPricingOverridesPathForTests(configPath);
});

afterEach(() => {
  _setPricingOverridesPathForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("overrideKey", () => {
  it("joins provider and model with a literal '::' separator", () => {
    expect(overrideKey("ollama", "llama3.1")).toBe("ollama::llama3.1");
  });

  it("survives a model id that itself contains slashes (openai-compatible composite ids)", () => {
    expect(overrideKey("openai-compatible", "together/meta-llama/Llama-3-70b")).toBe(
      "openai-compatible::together/meta-llama/Llama-3-70b"
    );
  });
});

describe("pricing-overrides config", () => {
  it("returns an empty map when the file is missing", () => {
    expect(readPricingOverrides()).toEqual({});
  });

  it("returns an empty map for malformed JSON", () => {
    fs.writeFileSync(configPath, "{not json");
    expect(readPricingOverrides()).toEqual({});
  });

  it("rethrows real I/O errors (not ENOENT) so they can be surfaced", () => {
    const dirPath = path.join(tempDir, "is-a-dir");
    fs.mkdirSync(dirPath);
    _setPricingOverridesPathForTests(dirPath);
    expect(() => readPricingOverrides()).toThrow();
  });

  it("round-trips overrides through write and read", () => {
    writePricingOverrides({
      "ollama::llama3.1": { inputPerMTokens: 0, outputPerMTokens: 0 },
      "openai-compatible::together/meta-llama/Llama-3-70b": { inputPerMTokens: 0.9, outputPerMTokens: 0.9 },
    });

    expect(readPricingOverrides()).toEqual({
      "ollama::llama3.1": { inputPerMTokens: 0, outputPerMTokens: 0 },
      "openai-compatible::together/meta-llama/Llama-3-70b": { inputPerMTokens: 0.9, outputPerMTokens: 0.9 },
    });
  });

  it("upserts a single override without disturbing the others", () => {
    upsertPricingOverride("ollama", "llama3.1", { inputPerMTokens: 0, outputPerMTokens: 0 });
    upsertPricingOverride("copilot", "gpt-5", { inputPerMTokens: 1.25, outputPerMTokens: 10 });

    expect(readPricingOverrides()).toEqual({
      "ollama::llama3.1": { inputPerMTokens: 0, outputPerMTokens: 0 },
      "copilot::gpt-5": { inputPerMTokens: 1.25, outputPerMTokens: 10 },
    });
  });

  it("deletes a single override, leaving the rest intact", () => {
    upsertPricingOverride("ollama", "llama3.1", { inputPerMTokens: 0, outputPerMTokens: 0 });
    upsertPricingOverride("copilot", "gpt-5", { inputPerMTokens: 1.25, outputPerMTokens: 10 });

    deletePricingOverride("ollama", "llama3.1");

    expect(readPricingOverrides()).toEqual({
      "copilot::gpt-5": { inputPerMTokens: 1.25, outputPerMTokens: 10 },
    });
  });

  it("deleting a non-existent override is a no-op", () => {
    upsertPricingOverride("copilot", "gpt-5", { inputPerMTokens: 1.25, outputPerMTokens: 10 });
    deletePricingOverride("ollama", "no-such-model");

    expect(readPricingOverrides()).toEqual({
      "copilot::gpt-5": { inputPerMTokens: 1.25, outputPerMTokens: 10 },
    });
  });

  it("preserves unknown top-level JSON keys across a write", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ overrides: {}, futureField: "keep-me" }));

    upsertPricingOverride("ollama", "llama3.1", { inputPerMTokens: 0, outputPerMTokens: 0 });

    const doc = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(doc.futureField).toBe("keep-me");
  });

  it("drops an entry with a non-numeric rate field on read, with a warning", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ overrides: { "ollama::llama3.1": { inputPerMTokens: "free" } } }));

    expect(readPricingOverrides()).toEqual({});
  });

  it("drops an entry with a negative rate field on read", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ overrides: { "ollama::llama3.1": { inputPerMTokens: -1 } } }));

    expect(readPricingOverrides()).toEqual({});
  });

  it("rejects writing an override with an invalid rate field", () => {
    expect(() => writePricingOverrides({ "ollama::llama3.1": { inputPerMTokens: Number.NaN } })).toThrow();
  });

  it("uses the default path under ~/.aichemist when no override is set", () => {
    _setPricingOverridesPathForTests(null);
    expect(getPricingOverridesPath()).toContain(path.join(".aichemist", "pricing-overrides.json"));
  });
});
