/**
 * Computes "remaining balance" and "burn rate" against a configured
 * {@link BudgetConfig} (`electron/budget.ts`) — the KPI-card numbers for the
 * Spending panel (epic #155). Reads real spend from the usage ledger
 * (`electron/usage-ledger.ts`) priced through the cost engine
 * (`electron/pricing.ts`), scoped to the current reset period.
 */
import type { Database } from "better-sqlite3";
import type { BudgetConfig, BudgetLineStatus, BudgetPeriod, BudgetStatus, Provider, ProviderBudgetStatus } from "../src/types/index";
import { getUsageByProviderModel } from "./usage-ledger";
import { estimateCost } from "./pricing";
import { readPricingOverrides } from "./pricing-overrides";
import { PROVIDER_IDS } from "./providers";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Floor on the elapsed-time denominator for burn rate. Without this, a turn
 * that lands moments after a period rolls over would divide by a
 * near-zero duration and report an absurd (or Infinity) $/day figure — one
 * real turn shouldn't look like a runaway burn just because the period is
 * young.
 */
const MIN_ELAPSED_MS = 60 * 60 * 1000; // 1 hour

/** Inclusive UTC start / exclusive UTC end of the period containing `now`. */
export function resolvePeriodBounds(period: BudgetPeriod, now: Date): { start: Date; end: Date } {
  switch (period) {
    case "daily": {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const end = new Date(start.getTime() + DAY_MS);
      return { start, end };
    }
    case "weekly": {
      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      // ISO week starts Monday: getUTCDay() is 0=Sun..6=Sat, so Mon(1)->0, Sun(0)->6.
      const daysSinceMonday = (dayStart.getUTCDay() + 6) % 7;
      const start = new Date(dayStart.getTime() - daysSinceMonday * DAY_MS);
      const end = new Date(start.getTime() + 7 * DAY_MS);
      return { start, end };
    }
    case "monthly":
    default: {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return { start, end };
    }
  }
}

function burnRatePerDay(spendUSD: number, periodStart: Date, now: Date): number {
  const elapsedMs = Math.max(now.getTime() - periodStart.getTime(), MIN_ELAPSED_MS);
  return spendUSD / (elapsedMs / DAY_MS);
}

function buildLineStatus(budgetUSD: number | null, spendUSD: number, periodStart: Date, now: Date): BudgetLineStatus {
  return {
    budgetUSD,
    spendUSD,
    remainingUSD: budgetUSD === null ? null : budgetUSD - spendUSD,
    burnRatePerDayUSD: burnRatePerDay(spendUSD, periodStart, now),
  };
}

/**
 * Compute the current period's spend/remaining/burn-rate against `config`.
 * `now` is injectable for deterministic tests; defaults to the real clock.
 */
export function computeBudgetStatus(db: Database, config: BudgetConfig, now: Date = new Date()): BudgetStatus {
  const { start, end } = resolvePeriodBounds(config.period, now);

  // Costing an aggregate requires per-model granularity (a provider's rows may
  // span several differently-priced models — see pricing.ts) — read the
  // overrides once and reuse across every estimateCost() call rather than
  // re-reading the file per row.
  const overrides = readPricingOverrides();
  const rows = getUsageByProviderModel(db, { since: start.toISOString(), until: end.toISOString() });

  const spendByProvider = new Map<Provider, number>();
  for (const row of rows) {
    const cost = estimateCost({ provider: row.provider, model: row.model, usage: row, overrides });
    spendByProvider.set(row.provider, (spendByProvider.get(row.provider) ?? 0) + cost.totalUSD);
  }

  const totalSpendUSD = [...spendByProvider.values()].reduce((sum, v) => sum + v, 0);
  const global = buildLineStatus(config.globalAmountUSD, totalSpendUSD, start, now);

  const byProvider: ProviderBudgetStatus[] = PROVIDER_IDS.filter(
    (p) => spendByProvider.has(p) || config.providerAmountUSD[p] !== undefined
  ).map((p) => ({
    provider: p,
    ...buildLineStatus(config.providerAmountUSD[p] ?? null, spendByProvider.get(p) ?? 0, start, now),
  }));

  return {
    period: config.period,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    global,
    byProvider,
  };
}
