// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setBudgetConfigPathForTests,
  emptyBudgetConfig,
  getBudgetConfigPath,
  readBudgetConfig,
  writeBudgetConfig,
} from "./budget";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  _setBudgetConfigPathForTests(path.join(tempDir, "budget.json"));
});

afterEach(() => {
  _setBudgetConfigPathForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("readBudgetConfig", () => {
  it("returns the default config when the file doesn't exist", () => {
    expect(readBudgetConfig()).toEqual(emptyBudgetConfig());
  });

  it("returns the default config for malformed JSON", () => {
    fs.mkdirSync(path.dirname(getBudgetConfigPath()), { recursive: true });
    fs.writeFileSync(getBudgetConfigPath(), "{ not json", "utf-8");
    expect(readBudgetConfig()).toEqual(emptyBudgetConfig());
  });

  it("rethrows real I/O errors other than ENOENT", () => {
    // Point the path at a directory, so reading it as a file throws EISDIR.
    _setBudgetConfigPathForTests(tempDir);
    expect(() => readBudgetConfig()).toThrow();
  });

  it("round-trips a global budget and period", () => {
    writeBudgetConfig({ period: "weekly", globalAmountUSD: 42, providerAmountUSD: {} });
    expect(readBudgetConfig()).toEqual({ period: "weekly", globalAmountUSD: 42, providerAmountUSD: {} });
  });

  it("round-trips per-provider overrides", () => {
    writeBudgetConfig({
      period: "monthly",
      globalAmountUSD: 100,
      providerAmountUSD: { anthropic: 50, ollama: 0.5 },
    });
    expect(readBudgetConfig()).toEqual({
      period: "monthly",
      globalAmountUSD: 100,
      providerAmountUSD: { anthropic: 50, ollama: 0.5 },
    });
  });

  it("normalizes a 0 global amount to null (unset)", () => {
    writeBudgetConfig({ period: "monthly", globalAmountUSD: 0, providerAmountUSD: {} });
    expect(readBudgetConfig().globalAmountUSD).toBeNull();
  });

  it("drops a provider override written as 0", () => {
    writeBudgetConfig({ period: "monthly", globalAmountUSD: null, providerAmountUSD: { anthropic: 0 } });
    expect(readBudgetConfig().providerAmountUSD).toEqual({});
  });

  it("falls back to the default period and drops the invalid field on a hand-edited file with a bad period", () => {
    fs.mkdirSync(path.dirname(getBudgetConfigPath()), { recursive: true });
    fs.writeFileSync(getBudgetConfigPath(), JSON.stringify({ period: "yearly", globalAmountUSD: 10 }), "utf-8");
    expect(readBudgetConfig()).toEqual({ period: "monthly", globalAmountUSD: 10, providerAmountUSD: {} });
  });

  it("drops a hand-edited negative global amount", () => {
    fs.mkdirSync(path.dirname(getBudgetConfigPath()), { recursive: true });
    fs.writeFileSync(getBudgetConfigPath(), JSON.stringify({ period: "monthly", globalAmountUSD: -5 }), "utf-8");
    expect(readBudgetConfig().globalAmountUSD).toBeNull();
  });

  it("drops a hand-edited override for an unrecognized provider", () => {
    fs.mkdirSync(path.dirname(getBudgetConfigPath()), { recursive: true });
    fs.writeFileSync(
      getBudgetConfigPath(),
      JSON.stringify({ period: "monthly", providerAmountUSD: { "not-a-provider": 10, anthropic: 20 } }),
      "utf-8"
    );
    expect(readBudgetConfig().providerAmountUSD).toEqual({ anthropic: 20 });
  });
});

describe("writeBudgetConfig", () => {
  it("throws on an invalid period", () => {
    expect(() =>
      writeBudgetConfig({ period: "yearly" as never, globalAmountUSD: null, providerAmountUSD: {} })
    ).toThrow(/period/i);
  });

  it("throws on a negative global amount", () => {
    expect(() => writeBudgetConfig({ period: "monthly", globalAmountUSD: -1, providerAmountUSD: {} })).toThrow(
      /non-negative/i
    );
  });

  it("throws on an unrecognized provider override key", () => {
    expect(() =>
      writeBudgetConfig({
        period: "monthly",
        globalAmountUSD: null,
        providerAmountUSD: { "not-a-provider": 10 } as never,
      })
    ).toThrow(/provider/i);
  });

  it("throws on a negative provider override amount", () => {
    expect(() =>
      writeBudgetConfig({ period: "monthly", globalAmountUSD: null, providerAmountUSD: { anthropic: -1 } })
    ).toThrow(/non-negative/i);
  });

  it("persists across a fresh read (simulating an app restart)", () => {
    writeBudgetConfig({ period: "daily", globalAmountUSD: 5, providerAmountUSD: { codex: 2 } });
    // Nothing in-memory is cached between these two calls — every read parses the file fresh.
    expect(readBudgetConfig()).toEqual({ period: "daily", globalAmountUSD: 5, providerAmountUSD: { codex: 2 } });
  });
});
