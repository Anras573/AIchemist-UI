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

  it("trims surrounding whitespace from the model, so a padded write and a trimmed read land on the same key", () => {
    expect(overrideKey("anthropic", "  claude-sonnet  ")).toBe("anthropic::claude-sonnet");
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

  it("treats a top-level JSON array as an empty config, not a document with numeric keys", () => {
    fs.writeFileSync(configPath, JSON.stringify([1, 2, 3]));
    expect(readPricingOverrides()).toEqual({});
  });

  it("does not silently drop a write when the existing file is a corrupted top-level array", () => {
    // typeof [] === "object" in JS — a naive "is this a document" check would
    // accept the array, assign `.overrides` onto it as a non-index property,
    // then JSON.stringify(array) would silently omit that property entirely,
    // discarding the write with no error.
    fs.writeFileSync(configPath, JSON.stringify(["not", "a", "doc"]));

    upsertPricingOverride("ollama", "llama3.1", { inputPerMTokens: 1 });

    expect(readPricingOverrides()).toEqual({ "ollama::llama3.1": { inputPerMTokens: 1 } });
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

  it("normalizes a hand-edited key with padding around the model half on read, so it still matches a trimmed lookup", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ overrides: { "anthropic::  my-model  ": { inputPerMTokens: 5 } } })
    );

    expect(readPricingOverrides()).toEqual({ "anthropic::my-model": { inputPerMTokens: 5 } });
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

  it("drops a key with no '::' separator on read — it could never match overrideKey()'s lookup format", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ overrides: { "ollama-llama3.1": { inputPerMTokens: 1 } } }));

    expect(readPricingOverrides()).toEqual({});
  });

  it("drops a key with an empty provider half (starts with '::') on read", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ overrides: { "::llama3.1": { inputPerMTokens: 1 } } }));

    expect(readPricingOverrides()).toEqual({});
  });

  it("drops a key with a whitespace-only provider half on read", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ overrides: { "   ::llama3.1": { inputPerMTokens: 1 } } }));

    expect(readPricingOverrides()).toEqual({});
  });

  it("drops a key whose provider half isn't a recognized Provider id (typo protection)", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        overrides: {
          "anthropic-v2::model": { inputPerMTokens: 1 },
          // "openai" is a tokenlens *catalog* provider id, not one of our app's
          // five Provider values — this key can never be looked up either.
          "openai::gpt-4o": { inputPerMTokens: 1 },
        },
      })
    );

    expect(readPricingOverrides()).toEqual({});
  });

  it("normalizes whitespace and case in the provider half on read, so a hand-edited key still matches", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        "overrides": {
          "anthropic ::padded-provider-model": { inputPerMTokens: 1 },
          "Ollama::mixed-case-provider-model": { inputPerMTokens: 2 },
        },
      })
    );

    expect(readPricingOverrides()).toEqual({
      "anthropic::padded-provider-model": { inputPerMTokens: 1 },
      "ollama::mixed-case-provider-model": { inputPerMTokens: 2 },
    });
  });

  it("drops a key with an empty or whitespace-only model half on read", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ overrides: { "ollama::": { inputPerMTokens: 1 }, "anthropic::   ": { inputPerMTokens: 1 } } })
    );

    expect(readPricingOverrides()).toEqual({});
  });

  it("rejects writing an override with an invalid rate field", () => {
    expect(() => writePricingOverrides({ "ollama::llama3.1": { inputPerMTokens: Number.NaN } })).toThrow();
  });

  it("rejects writing an override with no rate fields at all — it would look 'priced' while computing to $0 everywhere", () => {
    expect(() => writePricingOverrides({ "ollama::llama3.1": {} })).toThrow();
  });

  it("rejects writing a key that doesn't match '<provider>::<model>' — it would silently disappear on the next read otherwise", () => {
    expect(() => writePricingOverrides({ "not-a-valid-key": { inputPerMTokens: 1 } })).toThrow();
  });

  it("rejects writing a key with an unrecognized provider", () => {
    expect(() => writePricingOverrides({ "openai::gpt-4o": { inputPerMTokens: 1 } })).toThrow();
  });

  it("normalizes a key's whitespace/case on write, so a slightly malformed but recoverable key still round-trips", () => {
    writePricingOverrides({ "  Anthropic  ::  my-model  ": { inputPerMTokens: 1 } });

    expect(readPricingOverrides()).toEqual({ "anthropic::my-model": { inputPerMTokens: 1 } });
  });

  it("drops an entry with no rate fields at all on read", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ overrides: { "ollama::llama3.1": {} } }));

    expect(readPricingOverrides()).toEqual({});
  });

  it("uses the default path under ~/.aichemist when no override is set", () => {
    _setPricingOverridesPathForTests(null);
    expect(getPricingOverridesPath()).toContain(path.join(".aichemist", "pricing-overrides.json"));
  });
});
