import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { Provider, ProviderProbes } from "@/types";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { IssueLinkPicker } from "./IssueLinkPicker";

/** Empty-state chooser: radio buttons pick provider, button creates session. */
export function EmptyStateNewSession({
  defaultProvider,
  onNewSession,
  probes,
  error,
  projectPath,
}: {
  defaultProvider: string | null;
  onNewSession: (providerOverride?: string, issueNumber?: number) => void;
  probes?: ProviderProbes | null;
  error?: string | null;
  /** When provided, shows an optional issue picker. */
  projectPath?: string;
}) {
  const isAvailable = (p: Provider): boolean => {
    if (!probes) return true; // still checking — keep enabled
    return !probes[p] || probes[p].ok;
  };
  const reasonFor = (p: Provider): string | undefined => {
    if (!probes) return undefined;
    return probes[p]?.ok ? undefined : probes[p]?.reason;
  };
  // Pick a default that isn't disabled.
  const preferred =
    defaultProvider === "copilot"
      ? "copilot"
      : defaultProvider === "ollama"
        ? "ollama"
        : "anthropic";
  const initial: Provider = isAvailable(preferred as Provider)
    ? (preferred as Provider)
    : (["anthropic", "copilot", "ollama"] as const).find(isAvailable) ?? "anthropic";
  const [selected, setSelected] = useState<Provider>(initial);
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);

  // Probes arrive asynchronously after mount. If the initial pick (or a later
  // pick that has since gone unavailable) is no longer available, switch to
  // the first available provider so the Create button doesn't stay stuck
  // disabled with no visible re-selection.
  useEffect(() => {
    if (!probes) return;
    if (isAvailable(selected)) return;
    const fallback = (["anthropic", "copilot", "ollama"] as const).find(isAvailable);
    if (fallback && fallback !== selected) setSelected(fallback);
    // isAvailable is derived from `probes` which is in deps; selected is read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probes, selected]);

  const renderRadio = (
    p: Provider,
    label: string,
    icon: React.ReactNode,
  ) => {
    const available = isAvailable(p);
    const reason = reasonFor(p);
    const radio = (
      <label
        className={cn(
          "flex items-center gap-1.5 text-sm",
          available ? "cursor-pointer" : "cursor-not-allowed opacity-50",
        )}
      >
        <input
          type="radio"
          name="new-session-provider"
          value={p}
          checked={selected === p}
          onChange={() => setSelected(p)}
          disabled={!available}
          className="accent-primary"
        />
        {icon}
        <span>
          {label}
          {defaultProvider === p && (
            <span className="ml-1 text-[10px] text-muted-foreground">(default)</span>
          )}
          {!available && (
            <span className="ml-1 text-[10px] text-muted-foreground">(unavailable)</span>
          )}
        </span>
      </label>
    );
    if (!available) {
      return <WithTooltip label={`Unavailable: ${reason ?? "unknown"}`}>{radio}</WithTooltip>;
    }
    return radio;
  };

  const selectedAvailable = isAvailable(selected);

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        role="radiogroup"
        aria-label="Session provider"
        className="flex items-center gap-4"
      >
        {renderRadio("anthropic", "Use Claude", <ModelSelectorLogo provider="anthropic" className="size-3.5" />)}
        {renderRadio("copilot", "Use Copilot", <ModelSelectorLogo provider="github-copilot" className="size-3.5" />)}
        {renderRadio("ollama", "Use Ollama", <ModelSelectorLogo provider="ollama" className="size-3.5" />)}
      </div>
      {projectPath && (
        <IssueLinkPicker
          projectPath={projectPath}
          selectedNumber={selectedIssue}
          onChange={setSelectedIssue}
          className="max-w-xs w-full"
        />
      )}
      <button
        onClick={() => onNewSession(selected, selectedIssue ?? undefined)}
        disabled={!selectedAvailable}
        className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Create a new session
      </button>
      {error && (
        <p className="text-xs text-destructive text-center max-w-xs">{error}</p>
      )}
    </div>
  );
}
