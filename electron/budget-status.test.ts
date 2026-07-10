// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "./db";
import { computeBudgetStatus, resolvePeriodBounds } from "./budget-status";
import { emptyBudgetConfig } from "./budget";
import { _setPricingOverridesPathForTests } from "./pricing-overrides";
import { recordUsage } from "./usage-ledger";
import type { BudgetConfig } from "../src/types/index";

let db: Database.Database;
let tempDir: string;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  // usage_ledger rows FK-reference projects/sessions — seed the fixtures every test relies on.
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    "p1",
    "p1",
    "/tmp/p1",
    new Date().toISOString()
  );
  db.prepare("INSERT INTO sessions (id, project_id, title, status, created_at) VALUES (?, ?, 'S', 'idle', ?)").run(
    "s1",
    "p1",
    new Date().toISOString()
  );
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-status-"));
  _setPricingOverridesPathForTests(path.join(tempDir, "pricing-overrides.json"));
});

afterEach(() => {
  db.close();
  _setPricingOverridesPathForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const USAGE = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

describe("resolvePeriodBounds", () => {
  it("resolves the monthly period to the calendar month", () => {
    const { start, end } = resolvePeriodBounds("monthly", new Date("2026-07-10T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("resolves the daily period to the calendar day", () => {
    const { start, end } = resolvePeriodBounds("daily", new Date("2026-07-10T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-07-10T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-11T00:00:00.000Z");
  });

  it("resolves the weekly period to the ISO week (Monday start)", () => {
    // 2026-07-10 is a Friday.
    const { start, end } = resolvePeriodBounds("weekly", new Date("2026-07-10T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-07-06T00:00:00.000Z"); // Monday
    expect(end.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });
});

describe("computeBudgetStatus — unset budget", () => {
  it("degrades gracefully with no budget configured: remaining is null, spend is still reported", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: USAGE,
      createdAt: "2026-07-10T00:00:00.000Z",
    });

    const status = computeBudgetStatus(db, emptyBudgetConfig(), new Date("2026-07-10T12:00:00Z"));

    expect(status.global.budgetUSD).toBeNull();
    expect(status.global.remainingUSD).toBeNull();
    expect(status.global.spendUSD).toBeGreaterThan(0);
    expect(status.byProvider).toHaveLength(1);
    expect(status.byProvider[0].provider).toBe("anthropic");
    expect(status.byProvider[0].budgetUSD).toBeNull();
    expect(status.byProvider[0].remainingUSD).toBeNull();
  });

  it("reports zero spend and null remaining with no usage at all", () => {
    const status = computeBudgetStatus(db, emptyBudgetConfig(), new Date("2026-07-10T12:00:00Z"));
    expect(status.global.spendUSD).toBe(0);
    expect(status.global.remainingUSD).toBeNull();
    expect(status.global.burnRatePerDayUSD).toBe(0);
    expect(status.byProvider).toEqual([]);
  });
});

describe("computeBudgetStatus — configured budget", () => {
  it("computes remaining balance as budget minus real spend for the current period", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: USAGE,
      createdAt: "2026-07-10T00:00:00.000Z",
    });

    const config: BudgetConfig = { period: "monthly", globalAmountUSD: 100, providerAmountUSD: { anthropic: 50 } };
    const status = computeBudgetStatus(db, config, new Date("2026-07-10T12:00:00Z"));

    expect(status.global.budgetUSD).toBe(100);
    expect(status.global.spendUSD).toBeGreaterThan(0);
    expect(status.global.remainingUSD).toBeCloseTo(100 - status.global.spendUSD, 6);

    const anthropicLine = status.byProvider.find((p) => p.provider === "anthropic");
    expect(anthropicLine).toBeDefined();
    expect(anthropicLine!.budgetUSD).toBe(50);
    expect(anthropicLine!.remainingUSD).toBeCloseTo(50 - anthropicLine!.spendUSD, 6);
  });

  it("excludes usage outside the current period", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: USAGE,
      createdAt: "2026-06-15T00:00:00.000Z", // previous month
    });

    const config: BudgetConfig = { period: "monthly", globalAmountUSD: 100, providerAmountUSD: {} };
    const status = computeBudgetStatus(db, config, new Date("2026-07-10T12:00:00Z"));

    expect(status.global.spendUSD).toBe(0);
    expect(status.global.remainingUSD).toBe(100);
    expect(status.byProvider).toEqual([]);
  });

  it("includes a provider line for a configured override even with zero spend", () => {
    const config: BudgetConfig = { period: "monthly", globalAmountUSD: null, providerAmountUSD: { copilot: 25 } };
    const status = computeBudgetStatus(db, config, new Date("2026-07-10T12:00:00Z"));

    expect(status.byProvider).toHaveLength(1);
    expect(status.byProvider[0]).toMatchObject({ provider: "copilot", budgetUSD: 25, spendUSD: 0, remainingUSD: 25 });
  });

  it("computes a positive burn rate proportional to elapsed time in the period", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: USAGE,
      createdAt: "2026-07-05T00:00:00.000Z",
    });

    // 5 days into the monthly period starting 2026-07-01.
    const config: BudgetConfig = { period: "monthly", globalAmountUSD: 1000, providerAmountUSD: {} };
    const status = computeBudgetStatus(db, config, new Date("2026-07-06T00:00:00Z"));

    expect(status.global.burnRatePerDayUSD).toBeCloseTo(status.global.spendUSD / 5, 6);
  });

  it("floors the burn-rate denominator so a turn moments into the period doesn't blow up", () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: USAGE,
      createdAt: "2026-07-01T00:00:01.000Z",
    });

    const config: BudgetConfig = { period: "monthly", globalAmountUSD: 1000, providerAmountUSD: {} };
    const status = computeBudgetStatus(db, config, new Date("2026-07-01T00:00:05Z"));

    expect(Number.isFinite(status.global.burnRatePerDayUSD)).toBe(true);
    // Floored to a 1-hour minimum elapsed window, so burn rate <= spend * 24.
    expect(status.global.burnRatePerDayUSD).toBeLessThanOrEqual(status.global.spendUSD * 24 + 1e-9);
  });
});
