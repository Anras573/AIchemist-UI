import { useState, useEffect, useCallback, useMemo } from "react";
import { AlertCircle, Check, Loader2, Trash2 } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PROVIDER_IDS, PROVIDER_LABELS } from "../../../../electron/providers";
import type { BudgetConfig, BudgetLineStatus, BudgetPeriod, BudgetStatus, Provider } from "@/types";

const PERIOD_OPTIONS: { value: BudgetPeriod; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

function formatUSD(v: number): string {
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

/** Read-only KPI row for one budget line (global or a single provider). Degrades to "No budget set" rather than a negative/garbage remaining figure. */
function BudgetLineSummary({ label, line }: { label: string; line: BudgetLineStatus }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>Spent {formatUSD(line.spendUSD)}</span>
        {line.budgetUSD === null ? (
          <span className="italic">No budget set</span>
        ) : (
          <>
            <span className={line.remainingUSD !== null && line.remainingUSD < 0 ? "text-destructive font-medium" : ""}>
              {formatUSD(line.remainingUSD ?? 0)} left of {formatUSD(line.budgetUSD)}
            </span>
            <span>~{formatUSD(line.burnRatePerDayUSD)}/day</span>
          </>
        )}
      </div>
    </div>
  );
}

export function SpendingSection() {
  const ipc = useIpc();
  const [config, setConfig] = useState<BudgetConfig | null>(null);
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, st] = await Promise.all([ipc.budgetRead(), ipc.budgetGetStatus()]);
      setConfig(cfg);
      setStatus(st);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [ipc]);

  useEffect(() => {
    void load();
  }, [load]);

  const overrideProviders = useMemo(
    () => (config ? (Object.keys(config.providerAmountUSD) as Provider[]) : []),
    [config]
  );
  const availableProviders = useMemo(
    () => PROVIDER_IDS.filter((p) => !overrideProviders.includes(p)),
    [overrideProviders]
  );

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const next = await ipc.budgetWrite(config);
      setConfig(next);
      const st = await ipc.budgetGetStatus();
      setStatus(st);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const setGlobalAmount = (raw: string) => {
    if (!config) return;
    const parsed = raw.trim() === "" ? null : Number(raw);
    setConfig({ ...config, globalAmountUSD: parsed !== null && Number.isFinite(parsed) ? parsed : null });
  };

  const setPeriod = (period: BudgetPeriod) => {
    if (!config) return;
    setConfig({ ...config, period });
  };

  const setOverrideAmount = (provider: Provider, raw: string) => {
    if (!config) return;
    const parsed = raw.trim() === "" ? 0 : Number(raw);
    setConfig({
      ...config,
      providerAmountUSD: { ...config.providerAmountUSD, [provider]: Number.isFinite(parsed) ? parsed : 0 },
    });
  };

  const addOverride = (provider: Provider) => {
    if (!config) return;
    setConfig({ ...config, providerAmountUSD: { ...config.providerAmountUSD, [provider]: 0 } });
  };

  const removeOverride = (provider: Provider) => {
    if (!config) return;
    const next = { ...config.providerAmountUSD };
    delete next[provider];
    setConfig({ ...config, providerAmountUSD: next });
  };

  if (loading || !config) {
    return (
      <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Current period summary — read-only, reflects the last-saved config. */}
      {status && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Current {status.period} period
          </p>
          <BudgetLineSummary label="Global" line={status.global} />
          {status.byProvider.map((p) => (
            <BudgetLineSummary key={p.provider} label={PROVIDER_LABELS[p.provider]} line={p} />
          ))}
        </div>
      )}

      {/* Config form */}
      <div className="space-y-4 border-t border-border pt-4">
        <div className="grid grid-cols-[140px_1fr] gap-2 items-center">
          <label className="text-xs font-medium" htmlFor="budget-period">
            Reset period
          </label>
          <select
            id="budget-period"
            value={config.period}
            onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}
            className="flex h-8 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <label className="text-xs font-medium" htmlFor="budget-global">
            Global budget (USD)
          </label>
          <Input
            id="budget-global"
            type="number"
            min={0}
            step="any"
            placeholder="No budget set"
            value={config.globalAmountUSD ?? ""}
            onChange={(e) => setGlobalAmount(e.target.value)}
            className="font-mono text-sm"
          />
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium">Per-provider overrides</p>
          {overrideProviders.length === 0 && (
            <p className="text-xs text-muted-foreground">No per-provider overrides configured.</p>
          )}
          {overrideProviders.map((provider) => (
            <div key={provider} className="flex items-center gap-2">
              <span className="w-40 text-sm">{PROVIDER_LABELS[provider]}</span>
              <Input
                type="number"
                min={0}
                step="any"
                placeholder="No budget set"
                value={config.providerAmountUSD[provider] ?? ""}
                onChange={(e) => setOverrideAmount(provider, e.target.value)}
                className="font-mono text-sm w-32"
              />
              <Button variant="ghost" size="icon" onClick={() => removeOverride(provider)} aria-label={`Remove ${PROVIDER_LABELS[provider]} override`}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
          {availableProviders.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) addOverride(e.target.value as Provider);
              }}
              className="flex h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              aria-label="Add per-provider override"
            >
              <option value="">
                Add provider override…
              </option>
              {availableProviders.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Footer: save + status */}
      <div className="flex items-center gap-2 border-t border-border pt-3">
        {error && (
          <span className="text-xs text-destructive flex items-center gap-1 mr-auto">
            <AlertCircle className="h-3 w-3" /> {error}
          </span>
        )}
        {saved && (
          <span className="text-xs text-emerald-600 flex items-center gap-1 mr-auto">
            <Check className="h-3 w-3" /> Saved
          </span>
        )}
        <Button onClick={save} disabled={saving} className="ml-auto">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
