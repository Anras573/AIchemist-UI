// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}));

import { migrate } from "../db";
import { _setBudgetConfigPathForTests, emptyBudgetConfig } from "../budget";
import { _setPricingOverridesPathForTests } from "../pricing-overrides";
import { recordUsage } from "../usage-ledger";
import { registerBudgetHandlers } from "./budget-handlers";
import * as CH from "../ipc-channels";
import type { IpcEnvelope } from "./errors";
import type { BudgetConfig } from "../../src/types/index";

let db: Database.Database;
let tempDir: string;

async function call<T>(channel: string, ...payload: unknown[]): Promise<IpcEnvelope<T>> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  return (await fn({} as unknown, ...payload)) as IpcEnvelope<T>;
}

beforeEach(() => {
  handlers.clear();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-handlers-"));
  _setBudgetConfigPathForTests(path.join(tempDir, "budget.json"));
  _setPricingOverridesPathForTests(path.join(tempDir, "pricing-overrides.json"));

  db = new Database(":memory:");
  migrate(db);
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

  registerBudgetHandlers(db);
});

afterEach(() => {
  db.close();
  _setBudgetConfigPathForTests(null);
  _setPricingOverridesPathForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("BUDGET_READ / BUDGET_WRITE round trip", () => {
  it("reads the default config before anything is written", async () => {
    const env = await call<BudgetConfig>(CH.BUDGET_READ);
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.data).toEqual(emptyBudgetConfig());
  });

  it("persists a written config and returns it from a subsequent read", async () => {
    const config: BudgetConfig = { period: "weekly", globalAmountUSD: 75, providerAmountUSD: { anthropic: 30 } };
    const writeEnv = await call<BudgetConfig>(CH.BUDGET_WRITE, config);
    expect(writeEnv.ok).toBe(true);
    if (writeEnv.ok) expect(writeEnv.data).toEqual(config);

    const readEnv = await call<BudgetConfig>(CH.BUDGET_READ);
    expect(readEnv.ok).toBe(true);
    if (readEnv.ok) expect(readEnv.data).toEqual(config);
  });

  it("rejects a negative global amount at the handler boundary with invalid_input", async () => {
    const env = await call<BudgetConfig>(CH.BUDGET_WRITE, {
      period: "monthly",
      globalAmountUSD: -10,
      providerAmountUSD: {},
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("invalid_input");
  });

  it("rejects an unrecognized provider key in providerAmountUSD", async () => {
    const env = await call<BudgetConfig>(CH.BUDGET_WRITE, {
      period: "monthly",
      globalAmountUSD: null,
      providerAmountUSD: { "not-a-provider": 10 },
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("invalid_input");
  });
});

describe("BUDGET_GET_STATUS", () => {
  it("computes remaining balance against real usage-ledger spend for the just-written config", async () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    await call(CH.BUDGET_WRITE, { period: "monthly", globalAmountUSD: 100, providerAmountUSD: {} });

    const env = await call<{ global: { budgetUSD: number | null; remainingUSD: number | null; spendUSD: number } }>(
      CH.BUDGET_GET_STATUS
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.global.budgetUSD).toBe(100);
      expect(env.data.global.spendUSD).toBeGreaterThan(0);
      expect(env.data.global.remainingUSD).toBeCloseTo(100 - env.data.global.spendUSD, 6);
    }
  });

  it("degrades to a null remaining balance with no budget configured", async () => {
    const env = await call<{ global: { budgetUSD: number | null; remainingUSD: number | null } }>(
      CH.BUDGET_GET_STATUS
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.global.budgetUSD).toBeNull();
      expect(env.data.global.remainingUSD).toBeNull();
    }
  });
});
