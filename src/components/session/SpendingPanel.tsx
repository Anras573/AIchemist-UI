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
import type { BudgetStatus, CostConfidence, SessionStatusEvent, SpendingSummary } from "@/types";

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
    <WithTooltip label="Spend is aggregated across every provider used in this project. Rows marked “estimated” reflect partial token data or incomplete pricing coverage; remaining budget and burn rate come from your global budget settings (Settings → Spending), which apply across all projects.">
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
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const [preset, setPreset] = useState<RangePreset>("7d");
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");

  const range = useMemo(() => resolveRange(preset, customSince, customUntil), [preset, customSince, customUntil]);

  const summaryKey = activeProject ? `spending-summary:${activeProject.id}:${range.since}:${range.until}` : null;
  const summary = useIpcQuery<SpendingSummary>(
    summaryKey,
    () => ipc.spendingGetSummary({ projectId: activeProject!.id, since: range.since, until: range.until }),
    { ttl: 15_000 }
  );

  const budgetKey = activeProject ? "spending-budget-status" : null;
  const budget = useIpcQuery<BudgetStatus>(budgetKey, () => ipc.budgetGetStatus(), { ttl: 15_000 });

  // Refresh once a turn's usage row is durably recorded — `recordUsage()` runs
  // before the session transitions to "idle" (see electron/agent/runner.ts), so
  // by the time this fires the ledger already reflects the completed turn. Any
  // session's idle transition can affect this project's totals (a different
  // session in the same project, possibly a different provider), so this
  // deliberately ignores which session the event came from.
  useEffect(() => {
    return onSessionEvent<SessionStatusEvent>(IPC_CHANNELS.SESSION_STATUS, (payload) => {
      if (payload.status !== "idle") return;
      void summary.refetch();
      void budget.refetch();
    });
  }, [summary.refetch, budget.refetch]);

  if (!activeProject) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        No project open
      </div>
    );
  }

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

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4">
      {/* Time filters */}
      <div className="space-y-2">
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
        <KpiCard label="Lifetime" value={formatUSD(data.lifetimeSpendUSD)} confidence={data.lifetimeConfidence} />
        <KpiCard
          label="Remaining budget"
          value={
            !budgetStatus || budgetStatus.global.budgetUSD === null
              ? "No budget set"
              : formatUSD(budgetStatus.global.remainingUSD ?? 0)
          }
          sub={
            budgetStatus && budgetStatus.global.budgetUSD !== null
              ? `of ${formatUSD(budgetStatus.global.budgetUSD)} · ${budgetStatus.period}`
              : undefined
          }
        />
        <KpiCard
          label="Burn rate"
          value={budgetStatus ? `${formatUSD(budgetStatus.global.burnRatePerDayUSD)}/day` : "—"}
        />
      </div>

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
                      </span>
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
    </div>
  );
}
