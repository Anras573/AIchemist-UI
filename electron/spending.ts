/**
 * Project-scoped spend aggregation for the Spending panel (epic #155, issue
 * #159) — combines the usage ledger (`electron/usage-ledger.ts`) with the
 * cost engine (`electron/pricing.ts`) into the shape `SpendingPanel` renders:
 * a time-range-filtered per-provider breakdown plus that project's lifetime
 * total. Aggregates across every provider used in the project, per the
 * epic's cross-provider goal — this is deliberately NOT gated by a session's
 * provider lock the way Skills/MCP/Memory are.
 */
import type { Database } from "better-sqlite3";
import type { CostConfidence, Provider, SpendingSummary, SpendingProviderBreakdown } from "../src/types/index";
import { getUsageByProviderModel, type UsageFilter } from "./usage-ledger";
import { estimateCost } from "./pricing";
import { readPricingOverrides, type PricingOverrideMap } from "./pricing-overrides";

const CONFIDENCE_RANK: Record<CostConfidence, number> = { exact: 0, estimated: 1, unknown: 2 };

/** The less-trustworthy of the two — rolling up a group must never end up `exact` when any contributing row wasn't. */
function worseConfidence(a: CostConfidence, b: CostConfidence): CostConfidence {
  return CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a;
}

interface ProviderAccumulator {
  provider: Provider;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  turn_count: number;
  costUSD: number;
  confidence: CostConfidence;
}

/**
 * Cost + confidence per provider for `filter`, summed across every
 * provider+model group matching it. Costing an aggregate needs per-model
 * granularity (a provider's rows may span several differently-priced models
 * — see `pricing.ts`), so this reads `getUsageByProviderModel()` rather than
 * `getUsageByProvider()` and prices each group before rolling it up.
 */
function accumulateByProvider(
  db: Database,
  filter: UsageFilter,
  overrides: PricingOverrideMap
): Map<Provider, ProviderAccumulator> {
  const rows = getUsageByProviderModel(db, filter);
  const byProvider = new Map<Provider, ProviderAccumulator>();

  for (const row of rows) {
    const cost = estimateCost({ provider: row.provider, model: row.model, usage: row, overrides });
    const existing = byProvider.get(row.provider);
    if (existing) {
      existing.input_tokens += row.input_tokens;
      existing.output_tokens += row.output_tokens;
      existing.cache_read_input_tokens += row.cache_read_input_tokens;
      existing.cache_creation_input_tokens += row.cache_creation_input_tokens;
      existing.turn_count += row.turn_count;
      existing.costUSD += cost.totalUSD;
      existing.confidence = worseConfidence(existing.confidence, cost.confidence);
    } else {
      byProvider.set(row.provider, {
        provider: row.provider,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_input_tokens: row.cache_read_input_tokens,
        cache_creation_input_tokens: row.cache_creation_input_tokens,
        turn_count: row.turn_count,
        costUSD: cost.totalUSD,
        confidence: cost.confidence,
      });
    }
  }

  return byProvider;
}

function sumCost(byProvider: Map<Provider, ProviderAccumulator>): number {
  let total = 0;
  for (const p of byProvider.values()) total += p.costUSD;
  return total;
}

/**
 * Compute the Spending panel's data for one project: a per-provider
 * breakdown (tokens, cost, confidence, share of total) for `since`/`until`
 * (either bound omitted/null = unbounded), plus that project's all-time
 * spend. Backs `SPENDING_GET_SUMMARY`.
 */
export function getSpendingSummary(
  db: Database,
  params: { projectId: string; since?: string | null; until?: string | null }
): SpendingSummary {
  const overrides = readPricingOverrides();
  const range = { since: params.since ?? null, until: params.until ?? null };
  const isUnbounded = range.since === null && range.until === null;

  const periodFilter: UsageFilter = { projectId: params.projectId };
  if (range.since) periodFilter.since = range.since;
  if (range.until) periodFilter.until = range.until;

  const periodByProvider = accumulateByProvider(db, periodFilter, overrides);
  const periodSpendUSD = sumCost(periodByProvider);

  // Avoid a redundant identical query when the selected range is already unbounded.
  const lifetimeByProvider = isUnbounded
    ? periodByProvider
    : accumulateByProvider(db, { projectId: params.projectId }, overrides);
  const lifetimeSpendUSD = isUnbounded ? periodSpendUSD : sumCost(lifetimeByProvider);

  const byProvider: SpendingProviderBreakdown[] = [...periodByProvider.values()]
    .sort((a, b) => b.costUSD - a.costUSD)
    .map((p) => ({
      provider: p.provider,
      input_tokens: p.input_tokens,
      output_tokens: p.output_tokens,
      cache_read_input_tokens: p.cache_read_input_tokens,
      cache_creation_input_tokens: p.cache_creation_input_tokens,
      turn_count: p.turn_count,
      costUSD: p.costUSD,
      confidence: p.confidence,
      percentOfTotal: periodSpendUSD > 0 ? (p.costUSD / periodSpendUSD) * 100 : 0,
    }));

  return { projectId: params.projectId, range, periodSpendUSD, lifetimeSpendUSD, byProvider };
}
