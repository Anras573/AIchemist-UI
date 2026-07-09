// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "./db";
import { estimateCost } from "./pricing";
import { _setPricingOverridesPathForTests, readPricingOverrides, upsertPricingOverride } from "./pricing-overrides";
import { getUsageByProviderModel, recordUsage } from "./usage-ledger";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-"));
  _setPricingOverridesPathForTests(path.join(tempDir, "pricing-overrides.json"));
});

afterEach(() => {
  _setPricingOverridesPathForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const FULL_USAGE = { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 100_000 };

describe("estimateCost — known catalog pricing", () => {
  it("returns an exact cost matching Anthropic's published per-token pricing for a full usage reading", () => {
    // claude-3-7-sonnet-20250219: $3/$15/$0.30/$3.75 per 1M (input/output/cache_read/cache_write).
    const cost = estimateCost({ provider: "anthropic", model: "claude-3-7-sonnet-20250219", usage: FULL_USAGE });

    expect(cost.confidence).toBe("exact");
    expect(cost.inputUSD).toBeCloseTo(3, 5);
    expect(cost.outputUSD).toBeCloseTo(7.5, 5);
    expect(cost.cacheReadUSD).toBeCloseTo(0.06, 5);
    expect(cost.cacheCreationUSD).toBeCloseTo(0.375, 5);
    expect(cost.totalUSD).toBeCloseTo(3 + 7.5 + 0.06 + 0.375, 5);
  });

  it("resolves an openai-compatible composite model id against the OpenAI catalog entry", () => {
    // gpt-4o: $2.50/$10 per 1M input/output.
    const cost = estimateCost({
      provider: "openai-compatible",
      model: "myendpoint/gpt-4o",
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    expect(cost.confidence).toBe("exact");
    expect(cost.inputUSD).toBeCloseTo(2.5, 5);
    expect(cost.outputUSD).toBeCloseTo(10, 5);
  });

  it("resolves codex against the OpenAI catalog by bare model id (no composite id)", () => {
    const cost = estimateCost({
      provider: "codex",
      model: "gpt-4o",
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    expect(cost.confidence).toBe("exact");
    expect(cost.inputUSD).toBeCloseTo(2.5, 5);
  });

  it("degrades to 'estimated' when the catalog price is missing a field the turn actually used", () => {
    // gpt-4o's catalog entry has no cache_write price, so a turn that did
    // create cache tokens can't be priced exactly — usdFromTokens would
    // otherwise silently treat the missing rate as 0 while still reporting
    // "exact".
    const cost = estimateCost({
      provider: "openai-compatible",
      model: "myendpoint/gpt-4o",
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000 },
    });

    expect(cost.confidence).toBe("estimated");
    expect(cost.cacheCreationUSD).toBe(0);
  });

  it("degrades to 'estimated' for an all-zero usage reading, even with a fully-priced known model", () => {
    // An all-zero SessionUsage is indistinguishable from getLastUsage()'s
    // ZERO_USAGE fallback for a turn where the provider never called
    // TurnEmitter.usage() at all — reporting "exact $0" would be misleading.
    const cost = estimateCost({
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    expect(cost.confidence).toBe("estimated");
    expect(cost.totalUSD).toBe(0);
  });
});

describe("estimateCost — partial provider fidelity degrades confidence, not accuracy", () => {
  it("flags a Copilot cost as 'estimated', never 'exact', even with a fully-priced override", () => {
    upsertPricingOverride("copilot", "gpt-5", { inputPerMTokens: 1.25, outputPerMTokens: 10 });

    const cost = estimateCost({
      provider: "copilot",
      model: "gpt-5",
      usage: { input_tokens: 0, output_tokens: 500_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    // Copilot's input/cache token counts are known-unreliable today (see epic
    // #155), so even a fully-specified price can only ever be an estimate.
    expect(cost.confidence).toBe("estimated");
    expect(cost.outputUSD).toBeCloseTo(5, 5);
  });

  it("flags an Ollama cost as 'estimated' when a manual $0 override is configured", () => {
    upsertPricingOverride("ollama", "llama3.1", { inputPerMTokens: 0, outputPerMTokens: 0 });

    const cost = estimateCost({ provider: "ollama", model: "llama3.1", usage: FULL_USAGE });

    expect(cost.confidence).toBe("estimated");
    expect(cost.totalUSD).toBe(0);
  });
});

describe("estimateCost — manual overrides", () => {
  it("prefers a manual override over the catalog price for the same provider/model", () => {
    upsertPricingOverride("anthropic", "claude-3-7-sonnet-20250219", { inputPerMTokens: 1, outputPerMTokens: 1 });

    const cost = estimateCost({
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    expect(cost.inputUSD).toBeCloseTo(1, 5);
    expect(cost.outputUSD).toBeCloseTo(1, 5);
  });

  it("supplies pricing for a self-hosted Ollama model the catalog has no entry for", () => {
    upsertPricingOverride("ollama", "my-custom-finetune", { inputPerMTokens: 0.5, outputPerMTokens: 0.5 });

    const cost = estimateCost({
      provider: "ollama",
      model: "my-custom-finetune",
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    expect(cost.confidence).toBe("estimated");
    expect(cost.totalUSD).toBeCloseTo(1, 5);
  });

  it("supports partial override rates, defaulting unset fields to 0", () => {
    upsertPricingOverride("anthropic", "custom-model", { inputPerMTokens: 2 });

    const cost = estimateCost({
      provider: "anthropic",
      model: "custom-model",
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 },
    });

    expect(cost.inputUSD).toBeCloseTo(2, 5);
    expect(cost.outputUSD).toBe(0);
    expect(cost.cacheReadUSD).toBe(0);
    expect(cost.cacheCreationUSD).toBe(0);
    // Output/cache tokens were used but the override left those rates unset —
    // that's a pricing gap, not a genuine $0 price, so this must not read "exact".
    expect(cost.confidence).toBe("estimated");
  });

  it("still trims whitespace from the model before the override lookup, matching a key stored via upsertPricingOverride", () => {
    upsertPricingOverride("anthropic", "  padded-model  ", { inputPerMTokens: 5, outputPerMTokens: 5 });

    const cost = estimateCost({
      provider: "anthropic",
      model: "padded-model",
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    expect(cost.inputUSD).toBeCloseTo(5, 5);
  });

  it("accepts a pre-loaded overrides map via the `overrides` param, for a caller costing many rows without re-reading disk per call", () => {
    upsertPricingOverride("anthropic", "custom-model", { inputPerMTokens: 2, outputPerMTokens: 2 });
    const overrides = readPricingOverrides();

    // A completely empty file at the configured path — if estimateCost() fell
    // back to a fresh disk read despite `overrides` being passed, this override
    // would resolve to `undefined` and the assertions below would fail.
    _setPricingOverridesPathForTests(path.join(tempDir, "different-empty-file.json"));

    const cost = estimateCost({
      provider: "anthropic",
      model: "custom-model",
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      overrides,
    });

    expect(cost.inputUSD).toBeCloseTo(2, 5);
    expect(cost.outputUSD).toBeCloseTo(2, 5);
  });
});

describe("estimateCost — unknown provider/model", () => {
  it("returns 'unknown' confidence and all-zero cost for an unrecognized model, rather than throwing or reporting exact 0", () => {
    const cost = estimateCost({ provider: "anthropic", model: "totally-fake-model-xyz", usage: FULL_USAGE });

    expect(cost.confidence).toBe("unknown");
    expect(cost).toEqual({ inputUSD: 0, outputUSD: 0, cacheReadUSD: 0, cacheCreationUSD: 0, totalUSD: 0, confidence: "unknown" });
  });

  it("returns 'unknown' for GitHub Copilot models with no override — tokenlens ships no per-token cost for Copilot's flat-subscription pricing", () => {
    const cost = estimateCost({ provider: "copilot", model: "gpt-5", usage: FULL_USAGE });
    expect(cost.confidence).toBe("unknown");
  });

  it("returns 'unknown' for a null model rather than throwing", () => {
    const cost = estimateCost({ provider: "anthropic", model: null, usage: FULL_USAGE });
    expect(cost.confidence).toBe("unknown");
  });

  it("returns a fresh object each time, so mutating one 'unknown' result can't corrupt another", () => {
    const first = estimateCost({ provider: "anthropic", model: null, usage: FULL_USAGE });
    first.totalUSD = 999;
    first.confidence = "exact";

    const second = estimateCost({ provider: "anthropic", model: "totally-fake-model-xyz", usage: FULL_USAGE });

    expect(second).toEqual({ inputUSD: 0, outputUSD: 0, cacheReadUSD: 0, cacheCreationUSD: 0, totalUSD: 0, confidence: "unknown" });
  });

  it("returns 'unknown' for a whitespace-only model", () => {
    const cost = estimateCost({ provider: "anthropic", model: "   ", usage: FULL_USAGE });
    expect(cost.confidence).toBe("unknown");
  });

  it("returns 'unknown' for an ollama model with no override configured (no market price)", () => {
    const cost = estimateCost({ provider: "ollama", model: "llama3.1", usage: FULL_USAGE });
    expect(cost.confidence).toBe("unknown");
  });
});

describe("integration — costing the usage-ledger's provider/model aggregation", () => {
  function makeDb(): Database.Database {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('proj-1', 'P', '/tmp/p', ?)").run(new Date().toISOString());
    db.prepare("INSERT INTO sessions (id, project_id, title, status, created_at) VALUES ('sess-1', 'proj-1', 'S', 'idle', ?)").run(
      new Date().toISOString()
    );
    return db;
  }

  it("sums per-group costs across a mixed-model provider breakdown, each group priced independently", () => {
    const db = makeDb();
    recordUsage(db, {
      sessionId: "sess-1",
      projectId: "proj-1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    recordUsage(db, {
      sessionId: "sess-1",
      projectId: "proj-1",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const groups = getUsageByProviderModel(db, { projectId: "proj-1" });
    expect(groups).toHaveLength(2);

    const costs = groups.map((g) => estimateCost({ provider: g.provider, model: g.model, usage: g }));
    const totalUSD = costs.reduce((sum, c) => sum + c.totalUSD, 0);

    // claude-3-7-sonnet: $3/1M input; claude-3-5-haiku: $0.80/1M input.
    expect(totalUSD).toBeCloseTo(3 + 0.8, 5);
    expect(costs.every((c) => c.confidence === "exact")).toBe(true);
  });
});
