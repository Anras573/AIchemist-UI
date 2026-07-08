import * as crypto from "crypto";
import type { Database } from "better-sqlite3";
import type { Provider, SessionUsage } from "../src/types/index";

/**
 * Durable, queryable ledger of token usage — one row per completed agent turn,
 * across every provider. This is the foundation the pricing engine and the
 * Spending panel (both follow-ups, see epic #155) read from. Token counts are
 * whatever the provider reported for the turn; a partial/zero reading is valid
 * (provider fidelity varies — see epic #155), not an error condition.
 */

export interface UsageLedgerRow {
  id: string;
  session_id: string;
  project_id: string;
  provider: Provider;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  created_at: string;
}

/** Record one completed turn's token usage. Fails loudly — callers should treat this as best-effort and not let a write error break the turn. */
export function recordUsage(
  db: Database,
  params: {
    sessionId: string;
    projectId: string;
    provider: Provider;
    model: string | null;
    usage: SessionUsage;
    /** ISO timestamp; defaults to now. Exposed for deterministic tests. */
    createdAt?: string;
  }
): void {
  const model = params.model?.trim() || null;
  db.prepare(
    `INSERT INTO usage_ledger
       (id, session_id, project_id, provider, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    params.sessionId,
    params.projectId,
    params.provider,
    model,
    params.usage.input_tokens,
    params.usage.output_tokens,
    params.usage.cache_read_input_tokens,
    params.usage.cache_creation_input_tokens,
    params.createdAt ?? new Date().toISOString()
  );
}

/** Filters shared by every aggregation query. All fields are optional — an absent field is unconstrained. */
export interface UsageFilter {
  projectId?: string;
  provider?: Provider;
  sessionId?: string;
  /** ISO timestamp, inclusive lower bound on `created_at`. */
  since?: string;
  /** ISO timestamp, exclusive upper bound on `created_at`. */
  until?: string;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  turn_count: number;
}

export interface UsageByProvider extends UsageTotals {
  provider: Provider;
}

export interface UsageByProject extends UsageTotals {
  project_id: string;
}

export interface UsageBySession extends UsageTotals {
  session_id: string;
}

export interface UsageByDay extends UsageTotals {
  /** `YYYY-MM-DD`, derived from the `created_at` ISO timestamp's date prefix. */
  day: string;
}

function buildWhere(filter: UsageFilter): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) {
    conditions.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.provider) {
    conditions.push("provider = ?");
    params.push(filter.provider);
  }
  if (filter.sessionId) {
    conditions.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.since) {
    conditions.push("created_at >= ?");
    params.push(filter.since);
  }
  if (filter.until) {
    conditions.push("created_at < ?");
    params.push(filter.until);
  }
  return { clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

const TOTALS_SELECT = `
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
  COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
  COUNT(*) AS turn_count
`;

/** Aggregate token totals across all rows matching `filter` — the KPI-card rollup. */
export function getUsageTotals(db: Database, filter: UsageFilter = {}): UsageTotals {
  const { clause, params } = buildWhere(filter);
  return db
    .prepare(`SELECT ${TOTALS_SELECT} FROM usage_ledger ${clause}`)
    .get(...params) as UsageTotals;
}

/** Totals grouped by provider — backs the Spending panel's per-provider table. */
export function getUsageByProvider(db: Database, filter: UsageFilter = {}): UsageByProvider[] {
  const { clause, params } = buildWhere(filter);
  return db
    .prepare(
      `SELECT provider, ${TOTALS_SELECT} FROM usage_ledger ${clause} GROUP BY provider ORDER BY provider`
    )
    .all(...params) as UsageByProvider[];
}

/** Totals grouped by project — cross-project rollup. */
export function getUsageByProject(db: Database, filter: UsageFilter = {}): UsageByProject[] {
  const { clause, params } = buildWhere(filter);
  return db
    .prepare(
      `SELECT project_id, ${TOTALS_SELECT} FROM usage_ledger ${clause} GROUP BY project_id ORDER BY project_id`
    )
    .all(...params) as UsageByProject[];
}

/** Totals grouped by session — per-session breakdown within a project/provider/time window. */
export function getUsageBySession(db: Database, filter: UsageFilter = {}): UsageBySession[] {
  const { clause, params } = buildWhere(filter);
  return db
    .prepare(
      `SELECT session_id, ${TOTALS_SELECT} FROM usage_ledger ${clause} GROUP BY session_id ORDER BY session_id`
    )
    .all(...params) as UsageBySession[];
}

/** Totals grouped by calendar day (UTC date prefix of `created_at`) — backs time-series charts. */
export function getUsageByDay(db: Database, filter: UsageFilter = {}): UsageByDay[] {
  const { clause, params } = buildWhere(filter);
  return db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, ${TOTALS_SELECT} FROM usage_ledger ${clause} GROUP BY day ORDER BY day`
    )
    .all(...params) as UsageByDay[];
}
