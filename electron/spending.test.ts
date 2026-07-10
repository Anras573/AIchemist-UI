// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "./db";
import { getSpendingSummary } from "./spending";
import { _setPricingOverridesPathForTests, upsertPricingOverride } from "./pricing-overrides";
import { recordUsage } from "./usage-ledger";

let db: Database.Database;
let tempDir: string;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    "p1",
    "p1",
    "/tmp/p1",
    new Date().toISOString()
  );
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    "p2",
    "p2",
    "/tmp/p2",
    new Date().toISOString()
  );
  db.prepare("INSERT INTO sessions (id, project_id, title, status, created_at) VALUES (?, ?, 'S', 'idle', ?)").run(
    "s1",
    "p1",
    new Date().toISOString()
  );
  db.prepare("INSERT INTO sessions (id, project_id, title, status, created_at) VALUES (?, ?, 'S', 'idle', ?)").run(
    "s2",
    "p2",
    new Date().toISOString()
  );
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spending-"));
  _setPricingOverridesPathForTests(path.join(tempDir, "pricing-overrides.json"));
});

afterEach(() => {
  db.close();
  _setPricingOverridesPathForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const ANTHROPIC_USAGE = {
  input_tokens: 1_000_000,
  output_tokens: 500_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

describe("getSpendingSummary", () => {
  it("returns zeroed totals with an empty provider breakdown when there's no usage", () => {
    const summary = getSpendingSummary(db, { projectId: "p1" });
    expect(summary.periodSpendUSD).toBe(0);
    expect(summary.periodConfidence).toBe("exact");
    expect(summary.lifetimeSpendUSD).toBe(0);
    expect(summary.lifetimeConfidence).toBe("exact");
    expect(summary.byProvider).toEqual([]);
  });

  it("scopes totals to the given project — another project's usage is excluded", () => {
    recordUsage(db, {
      sessionId: "s2",
      projectId: "p2",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: ANTHROPIC_USAGE,
    });

    const summary = getSpendingSummary(db, { projectId: "p1" });
    expect(summary.periodSpendUSD).toBe(0);
    expect(summary.byProvider).toEqual([]);
  });

  it("computes cost and 100% share for a single-provider project", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: ANTHROPIC_USAGE,
    });

    const summary = getSpendingSummary(db, { projectId: "p1" });
    expect(summary.periodSpendUSD).toBeGreaterThan(0);
    expect(summary.byProvider).toHaveLength(1);
    expect(summary.byProvider[0].provider).toBe("anthropic");
    expect(summary.byProvider[0].percentOfTotal).toBeCloseTo(100, 6);
    expect(summary.byProvider[0].input_tokens).toBe(1_000_000);
    expect(summary.byProvider[0].turn_count).toBe(1);
  });

  it("splits percentOfTotal proportionally across multiple providers", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: ANTHROPIC_USAGE,
    });
    // A tiny copilot rate, so its cost is nonzero but far smaller than anthropic's — keeps ordering deterministic.
    upsertPricingOverride("copilot", "gpt-4o", { outputPerMTokens: 0.01 });
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "copilot",
      model: "gpt-4o",
      usage: { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const summary = getSpendingSummary(db, { projectId: "p1" });
    expect(summary.byProvider).toHaveLength(2);
    const percentages = summary.byProvider.map((p) => p.percentOfTotal);
    expect(percentages.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    // Sorted by costUSD descending — anthropic (real pricing) outweighs the zero-rate copilot override.
    expect(summary.byProvider[0].provider).toBe("anthropic");
  });

  it("flags a row as 'estimated' when the provider has known-partial fidelity", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "ollama",
      model: "llama3.2",
      usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    upsertPricingOverride("ollama", "llama3.2", { inputPerMTokens: 0, outputPerMTokens: 0 });

    const summary = getSpendingSummary(db, { projectId: "p1" });
    expect(summary.byProvider[0].confidence).toBe("estimated");
  });

  it("rolls a non-exact row's confidence up into periodConfidence and lifetimeConfidence", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "ollama",
      model: "llama3.2",
      usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    upsertPricingOverride("ollama", "llama3.2", { inputPerMTokens: 0, outputPerMTokens: 0 });

    const summary = getSpendingSummary(db, { projectId: "p1" });
    expect(summary.periodConfidence).toBe("estimated");
    expect(summary.lifetimeConfidence).toBe("estimated");
  });

  it("keeps periodConfidence 'exact' when every priced row is exact", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: ANTHROPIC_USAGE,
    });

    const summary = getSpendingSummary(db, { projectId: "p1" });
    expect(summary.byProvider[0].confidence).toBe("exact");
    expect(summary.periodConfidence).toBe("exact");
    expect(summary.lifetimeConfidence).toBe("exact");
  });

  it("excludes usage outside the requested since/until range from periodSpendUSD but keeps it in lifetimeSpendUSD", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: ANTHROPIC_USAGE,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const summary = getSpendingSummary(db, { projectId: "p1", since: "2026-06-01T00:00:00.000Z" });
    expect(summary.periodSpendUSD).toBe(0);
    expect(summary.byProvider).toEqual([]);
    expect(summary.lifetimeSpendUSD).toBeGreaterThan(0);
  });

  it("includes usage inside the requested since/until range", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: ANTHROPIC_USAGE,
      createdAt: "2026-07-05T00:00:00.000Z",
    });

    const summary = getSpendingSummary(db, {
      projectId: "p1",
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-08-01T00:00:00.000Z",
    });
    expect(summary.periodSpendUSD).toBeGreaterThan(0);
    expect(summary.byProvider).toHaveLength(1);
  });

  it("echoes the requested range back on the result, defaulting unset bounds to null", () => {
    const summary = getSpendingSummary(db, { projectId: "p1", since: "2026-07-01T00:00:00.000Z" });
    expect(summary.range).toEqual({ since: "2026-07-01T00:00:00.000Z", until: null });
  });

  it("degrades to catalog-only pricing (never throws) when the overrides read hits a real I/O error", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: ANTHROPIC_USAGE,
    });

    // Point the configured path at a directory — reading it throws EISDIR, a
    // real I/O error that readPricingOverrides() deliberately rethrows.
    // getSpendingSummary must not propagate it — SPENDING_GET_SUMMARY should
    // still return catalog-only pricing rather than failing the whole panel.
    const dirPath = path.join(tempDir, "is-a-dir");
    fs.mkdirSync(dirPath);
    _setPricingOverridesPathForTests(dirPath);

    const summary = getSpendingSummary(db, { projectId: "p1" });
    expect(summary.periodSpendUSD).toBeGreaterThan(0);
    expect(summary.byProvider[0].confidence).toBe("exact");
  });
});
