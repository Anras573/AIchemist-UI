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
  probe: ProviderProbeResult | undefined;
  onSelect: () => void;
  isDefault: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  const disabled = probe ? !probe.ok : false;

  // Pass `disabled` so Base UI skips the item in roving focus and prevents
  // selection. Override the resulting data-disabled:pointer-events-none with
  // !pointer-events-auto so hover events still reach the element and
  // WithTooltip can surface the reason.
  const item = (
    <DropdownMenuItem
      disabled={disabled}
      className={cn(disabled && "!pointer-events-auto")}
      onClick={() => { if (!disabled) onSelect(); }}
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
