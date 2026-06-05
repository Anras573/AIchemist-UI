import { cn } from "@/lib/utils";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { WithTooltip } from "@/components/ui/with-tooltip";
import type { ProviderProbeResult } from "@/types";

export function ProviderMenuItem({
  probe,
  onSelect,
  isDefault,
  label,
  icon,
}: {
  provider: "anthropic" | "copilot" | "ollama";
  probe: ProviderProbeResult | undefined;
  onSelect: () => void;
  isDefault: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  const disabled = probe ? !probe.ok : false;

  // Don't pass `disabled` to DropdownMenuItem — Base UI applies pointer-events-none
  // which would hide the tooltip. Use aria-disabled + manual guarding instead.
  const item = (
    <DropdownMenuItem
      aria-disabled={disabled}
      onClick={() => { if (!disabled) onSelect(); }}
      className={cn(disabled && "opacity-50 cursor-not-allowed")}
    >
      {icon}
      <span>{label}</span>
      {isDefault && (
        <span className="ml-auto text-[10px] text-muted-foreground">default</span>
      )}
    </DropdownMenuItem>
  );

  if (disabled) {
    return (
      <WithTooltip label={`Unavailable: ${probe?.reason ?? "unknown"}`}>
        {item}
      </WithTooltip>
    );
  }
  return item;
}
