import { useEffect, useMemo, useState } from "react";
import { AlertCircle, HelpCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIpc, IPC_CHANNELS, onSessionEvent } from "@/lib/ipc";
import { useIpcQuery } from "@/lib/hooks/useIpcQuery";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { PROVIDER_SHORT_LABELS } from "@/lib/providers";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { WithTooltip } from "@/components/ui/with-tooltip";
import type {
  BudgetStatus,
  CopilotQuotaSnapshot,
  CopilotQuotaStatus,
  CostConfidence,
  SessionStatusEvent,
  SpendingSummary,
} from "@/types";

// ── Scope ───────────────────────────────────────────────────────────────────────

type SpendingScope = "project" | "all";

const SCOPE_OPTIONS: { value: SpendingScope; label: string }[] = [
  { value: "project", label: "This project" },
  { value: "all", label: "All projects" },
];

// ── Time range presets ────────────────────────────────────────────────────────

type RangePreset = "today" | "7d" | "30d" | "custom";

const RANGE_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "custom", label: "Custom" },
];

function startOfTodayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** `until` is exclusive (see `UsageFilter`), so a custom end date must roll forward one day to include it. */
function endOfDayExclusive(dateInput: string): string {
  const d = new Date(dateInput);
  return new Date(d.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

function resolveRange(
  preset: RangePreset,
  customSince: string,
  customUntil: string
): { since: string | null; until: string | null } {
  if (preset === "custom") {
    return {
      since: customSince ? new Date(customSince).toISOString() : null,
      until: customUntil ? endOfDayExclusive(customUntil) : null,
    };
  }
  if (preset === "today") return { since: startOfTodayUTC().toISOString(), until: null };
  const days = preset === "7d" ? 7 : 30;
  return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(), until: null };
}

// ── Formatting ─────────────────────────────────────────────────────────────────

function formatUSD(v: number): string {
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function formatTokens(v: number): string {
  return v.toLocaleString();
}

/** Premium-request counts can be fractional (model multipliers like 0.33×). */
function formatRequests(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * A row/total priced `unknown` always carries `costUSD: 0` (`estimateCost()`
 * returns `zeroCost()` when no pricing data resolves) — that's a "we don't
 * know", not "this is free". Render a placeholder rather than `$0.00` so it
 * can't be misread as zero-cost usage.
 */
function formatCost(costUSD: number, confidence: CostConfidence): string {
  return confidence === "unknown" ? "—" : formatUSD(costUSD);
}

// ── Confidence badge ──────────────────────────────────────────────────────────

const CONFIDENCE_LABEL: Record<Exclude<CostConfidence, "exact">, string> = {
  estimated: "estimated",
  unknown: "unknown",
};

const CONFIDENCE_TOOLTIP: Record<Exclude<CostConfidence, "exact">, string> = {
  estimated: "Based on partial token data or incomplete pricing coverage — actual cost may differ.",
  unknown: "No pricing data is available for this provider/model — cost is not reflected in totals.",
};

function ConfidenceBadge({ confidence }: { confidence: CostConfidence }) {
  if (confidence === "exact") return null;
  return (
    <WithTooltip label={CONFIDENCE_TOOLTIP[confidence]}>
      <Badge
        variant="outline"
        aria-label={`${CONFIDENCE_LABEL[confidence]} cost`}
        className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      >
        {CONFIDENCE_LABEL[confidence]}
      </Badge>
    </WithTooltip>
  );
}

// ── Provider-reported badge ─────────────────────────────────────────────────────

function ReportedBadge({ reportedUSD, totalUSD }: { reportedUSD: number; totalUSD: number }) {
  if (reportedUSD <= 0) return null;
  const all = reportedUSD >= totalUSD - 1e-9;
  const label = all
    ? "Cost reported by the provider's SDK rather than estimated from token counts."
    : `${formatUSD(reportedUSD)} of ${formatUSD(totalUSD)} was reported by the provider's SDK; the rest is estimated from token counts.`;
  return (
    <WithTooltip label={label}>
      <Badge
        variant="outline"
        aria-label="provider-reported cost"
        className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400"
      >
        reported
      </Badge>
    </WithTooltip>
  );
}

// ── Copilot plan quota ──────────────────────────────────────────────────────────

const QUOTA_LABELS: Record<string, string> = {
  premium_interactions: "Premium requests",
  chat: "Chat",
  completions: "Completions",
};

function quotaLabel(key: string): string {
  return QUOTA_LABELS[key] ?? key.replace(/_/g, " ");
}

function formatResetDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Copilot's own view of the plan — premium requests used vs. included this
 * billing period, straight from the SDK's `account.getQuota()`. Unlimited
 * buckets (chat/completions on paid plans) are omitted as noise, except
 * premium requests, which are always shown.
 */
function CopilotQuotaCard({ snapshots }: { snapshots: CopilotQuotaSnapshot[] }) {
  const shown = snapshots
    .filter((q) => !q.unlimited || q.key === "premium_interactions")
    .sort((a, b) => (a.key === "premium_interactions" ? -1 : b.key === "premium_interactions" ? 1 : 0));
  if (shown.length === 0) return null;
  return (
    <div className="rounded-md border border-border px-3 py-2 space-y-2" aria-label="Copilot plan usage">
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Copilot plan (reported by GitHub)</p>
      {shown.map((q) => {
        const reset = formatResetDate(q.resetDate);
        const usedPct = q.unlimited || q.entitlement <= 0 ? 0 : Math.min(100, (q.used / q.entitlement) * 100);
        return (
          <div key={q.key} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span>{quotaLabel(q.key)}</span>
              <span className="tabular-nums font-medium">
                {q.unlimited ? "Unlimited" : `${formatRequests(q.used)} / ${formatRequests(q.entitlement)}`}
              </span>
            </div>
            {!q.unlimited && (
              <div
                className="h-1.5 rounded-full bg-muted overflow-hidden"
                role="progressbar"
                aria-label={`${quotaLabel(q.key)} used`}
                aria-valuenow={Math.round(usedPct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={cn("h-full rounded-full", usedPct >= 90 ? "bg-destructive" : "bg-foreground/60")}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
            )}
            {(!q.unlimited || reset) && (
              <p className="text-[11px] text-muted-foreground">
                {[
                  !q.unlimited ? `${Math.round(q.remainingPercentage)}% left` : null,
                  q.overage > 0 ? `${formatRequests(q.overage)} over` : null,
                  reset ? `resets ${reset}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── KPI card ───────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  confidence,
}: {
  label: string;
  value: string;
  sub?: string;
  /** When set and non-`exact`, marks `value` as not fully trustworthy — a total built from partial/unpriced data must not read as exact. */
  confidence?: CostConfidence;
}) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-base font-semibold tabular-nums truncate flex items-center gap-1.5">
        {value}
        {confidence && <ConfidenceBadge confidence={confidence} />}
      </p>
      {sub && <p className="text-[11px] text-muted-foreground truncate">{sub}</p>}
    </div>
  );
}

// ── Header info tooltip (mirrors SkillsHeaderInfo's pattern) ─────────────────

export function SpendingHeaderInfo() {
  return (
    <WithTooltip
      label={
        <div className="flex flex-col gap-1 max-w-[280px] text-[11px]">
          <span className="font-medium">How costs are calculated:</span>
          <span className="text-muted-foreground">
            Each turn&apos;s recorded token counts are priced against published per-token API rates
            (plus your pricing overrides in Settings → Spending) — this is an estimate, not your
            provider&apos;s actual invoice.
          </span>
          <span className="text-muted-foreground">
            Flat-subscription plans (e.g. Claude Pro/Max) are priced as if pay-per-token, so this does
            not reflect your real plan quota or remaining allowance.
          </span>
          <span className="text-muted-foreground">
            Rows marked &ldquo;estimated&rdquo; reflect partial token data or incomplete pricing
            coverage. Remaining budget and burn rate come from your global budget settings, which apply
            across all projects.
          </span>
          <span className="text-muted-foreground">
            Rows marked &ldquo;reported&rdquo; use the cost the provider&apos;s own SDK computed
            (Claude Agent SDK) instead of our estimate. Copilot rows show premium requests, and the
            Copilot plan card shows your quota as GitHub reports it.
          </span>
          <span className="text-muted-foreground">
            Switch to &ldquo;All projects&rdquo; for a total breakdown across every project.
          </span>
        </div>
      }
      side="left"
    >
      <button
        type="button"
        aria-label="About the Spending tab"
        className="flex items-center justify-center h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
    </WithTooltip>
  );
}

// ── SpendingPanel ──────────────────────────────────────────────────────────────

export function SpendingPanel() {
  const ipc = useIpc();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeProject = useProjectStore((s) =>
    s.projects.find((p) => p.id === activeProjectId)
  );

  const [scope, setScope] = useState<SpendingScope>("project");
  // Without an open project there's nothing to scope to — fall back to the
  // all-projects rollup rather than showing an empty panel.
  const effectiveScope: SpendingScope = activeProject ? scope : "all";
  const scopedProjectId = effectiveScope === "project" ? activeProject!.id : null;

  const [preset, setPreset] = useState<RangePreset>("7d");
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");

  const range = useMemo(() => resolveRange(preset, customSince, customUntil), [preset, customSince, customUntil]);

  const summaryKey = `spending-summary:${scopedProjectId ?? "*"}:${range.since}:${range.until}`;
  const summary = useIpcQuery<SpendingSummary>(
    summaryKey,
    () => ipc.spendingGetSummary({ projectId: scopedProjectId, since: range.since, until: range.until }),
    { ttl: 15_000 }
  );

  const budgetKey = "spending-budget-status";
  const budget = useIpcQuery<BudgetStatus>(budgetKey, () => ipc.budgetGetStatus(), { ttl: 15_000 });

  const copilotQuota = useIpcQuery<CopilotQuotaStatus>(
    "spending-copilot-quota",
    () => ipc.spendingCopilotQuota(),
    { ttl: 60_000 }
  );

  // Refresh once a turn's usage row is durably recorded — `recordUsage()` runs
  // before the session transitions to "idle" (see electron/agent/runner.ts), so
  // by the time this fires the ledger already reflects the completed turn. Any
  // session's idle transition can affect the displayed totals (a different
  // session in the same project, possibly a different provider — or any
  // project at all in the all-projects scope), so this deliberately ignores
  // which session the event came from.
  useEffect(() => {
    return onSessionEvent<SessionStatusEvent>(IPC_CHANNELS.SESSION_STATUS, (payload) => {
      if (payload.status !== "idle") return;
      void summary.refetch();
      void budget.refetch();
      void copilotQuota.refetch();
    });
  }, [summary.refetch, budget.refetch, copilotQuota.refetch]);

  const scopeToggle = (
    <div className="flex items-center gap-1" role="group" aria-label="Spending scope">
      {SCOPE_OPTIONS.map((o) => {
        const disabled = o.value === "project" && !activeProject;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => setScope(o.value)}
            disabled={disabled}
            aria-pressed={effectiveScope === o.value}
            className={cn(
              "px-2 py-1 rounded-sm text-xs font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none",
              effectiveScope === o.value
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );

  if (summary.loading) {
    return (
      <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (!summary.data) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-2 text-sm">
        {scopeToggle}
        <span className="flex items-center gap-1 text-destructive">
          <AlertCircle className="h-4 w-4" /> {String(summary.error ?? "Failed to load spending data.")}
        </span>
        <Button variant="outline" size="sm" onClick={() => void summary.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const data = summary.data;
  const budgetStatus = budget.data;
  const rangeLabel = RANGE_OPTIONS.find((o) => o.value === preset)?.label ?? "Period";

  // Prefer real (possibly stale-while-revalidating) budget data whenever it's
  // present; only fall back to a loading/error placeholder when there's none
  // yet — otherwise a background revalidation failure would blank out a
  // previously-loaded budget, and a still-loading first fetch would
  // misleadingly read as "No budget set" rather than "we don't know yet".
  const remainingBudget = budgetStatus
    ? budgetStatus.global.budgetUSD === null
      ? { value: "No budget set" }
      : {
          value: formatUSD(budgetStatus.global.remainingUSD ?? 0),
          sub: `of ${formatUSD(budgetStatus.global.budgetUSD)} · ${budgetStatus.period}`,
        }
    : { value: budget.loading ? "Loading…" : budget.error ? "Error loading budget" : "No budget set" };
  const burnRate = budgetStatus
    ? `${formatUSD(budgetStatus.global.burnRatePerDayUSD)}/day`
    : budget.loading
      ? "Loading…"
      : budget.error
        ? "Error"
        : "—";

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4">
      {/* Scope + time filters */}
      <div className="space-y-2">
        {scopeToggle}
        <div className="flex items-center gap-1" role="group" aria-label="Time range">
          {RANGE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setPreset(o.value)}
              aria-pressed={preset === o.value}
              className={cn(
                "px-2 py-1 rounded-sm text-xs font-medium transition-colors",
                preset === o.value
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              aria-label="Custom range start"
              value={customSince}
              max={customUntil || undefined}
              onChange={(e) => setCustomSince(e.target.value)}
              className="h-7 rounded-sm border border-input bg-transparent px-1.5 text-xs"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              aria-label="Custom range end"
              value={customUntil}
              min={customSince || undefined}
              onChange={(e) => setCustomUntil(e.target.value)}
              className="h-7 rounded-sm border border-input bg-transparent px-1.5 text-xs"
            />
          </div>
        )}
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-2">
        <KpiCard label={rangeLabel} value={formatUSD(data.periodSpendUSD)} confidence={data.periodConfidence} />
        <KpiCard label={effectiveScope === "all" ? "Lifetime (all)" : "Lifetime"} value={formatUSD(data.lifetimeSpendUSD)} confidence={data.lifetimeConfidence} />
        <KpiCard label="Remaining budget" value={remainingBudget.value} sub={remainingBudget.sub} />
        <KpiCard label="Burn rate" value={burnRate} />
      </div>

      {copilotQuota.data?.ok && <CopilotQuotaCard snapshots={copilotQuota.data.snapshots} />}

      {/* Provider breakdown */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">By provider</p>
        {data.byProvider.length === 0 ? (
          <p className="text-xs text-muted-foreground">No usage recorded in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-1 pr-2 font-medium">Provider</th>
                  <th className="py-1 pr-2 font-medium text-right">Input</th>
                  <th className="py-1 pr-2 font-medium text-right">Output</th>
                  <th className="py-1 pr-2 font-medium text-right">Cache</th>
                  <th className="py-1 pr-2 font-medium text-right">Cost</th>
                  <th className="py-1 font-medium text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {data.byProvider.map((p) => (
                  <tr key={p.provider} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-2">
                      <span className="flex items-center gap-1.5">
                        {PROVIDER_SHORT_LABELS[p.provider]}
                        <ConfidenceBadge confidence={p.confidence} />
                        <ReportedBadge reportedUSD={p.reportedCostUSD} totalUSD={p.costUSD} />
                      </span>
                      {p.premiumRequests !== null && (
                        <span className="block text-[11px] text-muted-foreground tabular-nums">
                          {`${formatRequests(p.premiumRequests)} premium req.`}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatTokens(p.input_tokens)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatTokens(p.output_tokens)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {formatTokens(p.cache_read_input_tokens + p.cache_creation_input_tokens)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatCost(p.costUSD, p.confidence)}</td>
                    <td className="py-1.5 text-right tabular-nums">{`${p.percentOfTotal.toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Project breakdown (all-projects scope only) */}
      {effectiveScope === "all" && data.byProject.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">By project</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-1 pr-2 font-medium">Project</th>
                  <th className="py-1 pr-2 font-medium text-right">Turns</th>
                  <th className="py-1 pr-2 font-medium text-right">Cost</th>
                  <th className="py-1 font-medium text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {data.byProject.map((p) => (
                  <tr key={p.projectId} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-2 max-w-0 w-full">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate">{p.projectName ?? "Unknown project"}</span>
                        <ConfidenceBadge confidence={p.confidence} />
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatTokens(p.turn_count)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatCost(p.costUSD, p.confidence)}</td>
                    <td className="py-1.5 text-right tabular-nums">{`${p.percentOfTotal.toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
