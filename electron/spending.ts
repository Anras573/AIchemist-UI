/**
 * Spend aggregation for the Spending panel (epic #155, issue #159) — combines
 * the usage ledger (`electron/usage-ledger.ts`) with the cost engine
 * (`electron/pricing.ts`) into the shape `SpendingPanel` renders: a
 * time-range-filtered per-provider breakdown plus the lifetime total, scoped
 * to one project or rolled up across every project (with a per-project
 * breakdown). Aggregates across every provider used in the project, per the
 * epic's cross-provider goal — this is deliberately NOT gated by a session's
 * provider lock the way Skills/MCP/Memory are.
 */
import type { Database } from "better-sqlite3";
import type {
  CostConfidence,
  Provider,
  SpendingSummary,
  SpendingProjectBreakdown,
  SpendingProviderBreakdown,
} from "../src/types/index";
import { getUsageByProjectProviderModel, getUsageByProviderModel, type UsageFilter } from "./usage-ledger";
import { costUsageGroup, safeReadPricingOverrides } from "./pricing";
import type { PricingOverrideMap } from "./pricing-overrides";

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
  reportedCostUSD: number;
  premiumRequests: number | null;
}

/** Sum two optional counts — `null` only when both are. */
function addNullable(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
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
    const cost = costUsageGroup(row, overrides);
    const existing = byProvider.get(row.provider);
    if (existing) {
      existing.input_tokens += row.input_tokens;
      existing.output_tokens += row.output_tokens;
      existing.cache_read_input_tokens += row.cache_read_input_tokens;
      existing.cache_creation_input_tokens += row.cache_creation_input_tokens;
      existing.turn_count += row.turn_count;
      existing.costUSD += cost.totalUSD;
      existing.confidence = worseConfidence(existing.confidence, cost.confidence);
      existing.reportedCostUSD += cost.reportedUSD;
      existing.premiumRequests = addNullable(existing.premiumRequests, row.premium_requests);
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
        reportedCostUSD: cost.reportedUSD,
        premiumRequests: row.premium_requests,
      });
    }
  }

  return byProvider;
}

interface ProjectAccumulator {
  projectId: string;
  turn_count: number;
  costUSD: number;
  confidence: CostConfidence;
}

/** Cost + confidence per project for `filter` — priced per provider+model group, then rolled up by project. */
function accumulateByProject(
  db: Database,
  filter: UsageFilter,
  overrides: PricingOverrideMap
): Map<string, ProjectAccumulator> {
  const byProject = new Map<string, ProjectAccumulator>();
  for (const row of getUsageByProjectProviderModel(db, filter)) {
    const cost = costUsageGroup(row, overrides);
    const existing = byProject.get(row.project_id);
    if (existing) {
      existing.turn_count += row.turn_count;
      existing.costUSD += cost.totalUSD;
      existing.confidence = worseConfidence(existing.confidence, cost.confidence);
    } else {
      byProject.set(row.project_id, {
        projectId: row.project_id,
        turn_count: row.turn_count,
        costUSD: cost.totalUSD,
        confidence: cost.confidence,
      });
    }
  }
  return byProject;
}

function projectNames(db: Database, ids: string[]): Map<string, string> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const rows = db
    .prepare(`SELECT id, name FROM projects WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids) as { id: string; name: string }[];
  for (const r of rows) names.set(r.id, r.name);
  return names;
}

function sumCost(byProvider: Map<Provider, ProviderAccumulator>): number {
  let total = 0;
  for (const p of byProvider.values()) total += p.costUSD;
  return total;
}

/** Worst-of confidence across every provider — `exact` when there's nothing to roll up (no usage). */
function overallConfidence(byProvider: Map<Provider, ProviderAccumulator>): CostConfidence {
  let confidence: CostConfidence = "exact";
  for (const p of byProvider.values()) confidence = worseConfidence(confidence, p.confidence);
  return confidence;
}

/**
 * Compute the Spending panel's data: a per-provider breakdown (tokens, cost,
 * confidence, share of total) for `since`/`until` (either bound omitted/null =
 * unbounded), plus all-time spend. Scoped to `projectId` when given; when it's
 * omitted/null, rolls up across every project and also returns a per-project
 * breakdown. Backs `SPENDING_GET_SUMMARY`.
 */
export function getSpendingSummary(
  db: Database,
  params: { projectId?: string | null; since?: string | null; until?: string | null }
): SpendingSummary {
  const projectId = params.projectId ?? null;
  // A broken pricing-overrides file must not fail the whole panel — degrade to
  // catalog-only pricing rather than rejecting SPENDING_GET_SUMMARY outright.
  const overrides = safeReadPricingOverrides();
  const range = { since: params.since ?? null, until: params.until ?? null };
  const isUnbounded = range.since === null && range.until === null;

  const scopeFilter: UsageFilter = projectId ? { projectId } : {};
  const periodFilter: UsageFilter = { ...scopeFilter };
  if (range.since) periodFilter.since = range.since;
  if (range.until) periodFilter.until = range.until;

  const periodByProvider = accumulateByProvider(db, periodFilter, overrides);
  const periodSpendUSD = sumCost(periodByProvider);
  const periodConfidence = overallConfidence(periodByProvider);

  // Avoid a redundant identical query when the selected range is already unbounded.
  const lifetimeByProvider = isUnbounded
    ? periodByProvider
    : accumulateByProvider(db, scopeFilter, overrides);
  const lifetimeSpendUSD = isUnbounded ? periodSpendUSD : sumCost(lifetimeByProvider);
  const lifetimeConfidence = isUnbounded ? periodConfidence : overallConfidence(lifetimeByProvider);

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
      reportedCostUSD: p.reportedCostUSD,
      premiumRequests: p.premiumRequests,
    }));

  let byProject: SpendingProjectBreakdown[] = [];
  if (projectId === null) {
    const periodByProject = accumulateByProject(db, periodFilter, overrides);
    const names = projectNames(db, [...periodByProject.keys()]);
    byProject = [...periodByProject.values()]
      .sort((a, b) => b.costUSD - a.costUSD)
      .map((p) => ({
        projectId: p.projectId,
        projectName: names.get(p.projectId) ?? null,
        turn_count: p.turn_count,
        costUSD: p.costUSD,
        confidence: p.confidence,
        percentOfTotal: periodSpendUSD > 0 ? (p.costUSD / periodSpendUSD) * 100 : 0,
      }));
  }

  return {
    projectId,
    range,
    periodSpendUSD,
    periodConfidence,
    lifetimeSpendUSD,
    lifetimeConfidence,
    byProvider,
    byProject,
  };
}
