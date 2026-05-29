import { useState } from "react";
import { Cable } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { IssueLinkPicker } from "@/components/session/IssueLinkPicker";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ProviderProbes } from "@/types";

interface NewSessionWithIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  defaultProvider: string | null;
  probes?: ProviderProbes | null;
  onCreate: (providerOverride: string, issueNumber?: number) => void;
}

type Provider = "anthropic" | "copilot" | "ollama" | "acp";
const PROVIDERS: Provider[] = ["anthropic", "copilot", "ollama", "acp"];

function providerLabel(p: Provider): string {
  switch (p) {
    case "anthropic": return "Claude";
    case "copilot": return "Copilot";
    case "ollama": return "Ollama";
    case "acp": return "ACP";
  }
}

function providerIcon(p: Provider): React.ReactNode {
  switch (p) {
    case "anthropic": return <ModelSelectorLogo provider="anthropic" className="size-3.5" />;
    case "copilot": return <ModelSelectorLogo provider="github-copilot" className="size-3.5" />;
    case "ollama": return <ModelSelectorLogo provider="ollama" className="size-3.5" />;
    case "acp": return <Cable className="size-3.5" />;
  }
}

export function NewSessionWithIssueDialog({
  open,
  onOpenChange,
  projectPath,
  defaultProvider,
  probes,
  onCreate,
}: NewSessionWithIssueDialogProps) {
  const isAvailable = (p: Provider): boolean => {
    if (!probes) return true;
    const probe = p === "acp" ? probes.acp : probes[p];
    return !probe || probe.ok;
  };

  const reasonFor = (p: Provider): string | undefined => {
    if (!probes) return undefined;
    const probe = p === "acp" ? probes.acp : probes[p];
    return probe?.ok ? undefined : probe?.reason;
  };

  const preferred =
    defaultProvider === "copilot" ? "copilot"
    : defaultProvider === "ollama" ? "ollama"
    : defaultProvider === "acp" ? "acp"
    : "anthropic";

  const initial: Provider = isAvailable(preferred as Provider)
    ? (preferred as Provider)
    : PROVIDERS.find(isAvailable) ?? "anthropic";

  const [selected, setSelected] = useState<Provider>(initial);
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);

  const selectedAvailable = isAvailable(selected);

  const handleCreate = () => {
    onCreate(selected, selectedIssue ?? undefined);
    onOpenChange(false);
    setSelectedIssue(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New session linked to issue</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 pt-1">
          {/* Provider selector */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground font-medium">Provider</span>
            <div
              role="radiogroup"
              aria-label="Session provider"
              className="flex flex-wrap gap-x-4 gap-y-1.5"
            >
              {PROVIDERS.map((p) => {
                const available = isAvailable(p);
                const reason = reasonFor(p);
                const radio = (
                  <label
                    key={p}
                    className={cn(
                      "flex items-center gap-1.5 text-sm",
                      available ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                    )}
                  >
                    <input
                      type="radio"
                      name="dialog-provider"
                      value={p}
                      checked={selected === p}
                      onChange={() => setSelected(p)}
                      disabled={!available}
                      className="accent-primary"
                    />
                    {providerIcon(p)}
                    <span>
                      {providerLabel(p)}
                      {defaultProvider === p && (
                        <span className="ml-1 text-[10px] text-muted-foreground">(default)</span>
                      )}
                      {!available && (
                        <span className="ml-1 text-[10px] text-muted-foreground">(unavailable)</span>
                      )}
                    </span>
                  </label>
                );
                return !available ? (
                  <WithTooltip key={p} label={`Unavailable: ${reason ?? "unknown"}`}>{radio}</WithTooltip>
                ) : radio;
              })}
            </div>
          </div>

          {/* Issue picker */}
          <IssueLinkPicker
            projectPath={projectPath}
            selectedNumber={selectedIssue}
            onChange={setSelectedIssue}
          />

          <button
            type="button"
            onClick={handleCreate}
            disabled={!selectedAvailable}
            className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed self-end"
          >
            Create Session
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
