import { cn } from "@/lib/utils";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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
  return (
    <DropdownMenuItem
      disabled={disabled}
      onClick={() => { if (!disabled) onSelect(); }}
      title={disabled ? `Unavailable: ${probe?.reason ?? "unknown"}` : undefined}
    >
      {icon}
      <span className={cn(disabled && "text-muted-foreground")}>{label}</span>
      {disabled && (
        <span className="ml-1 text-[10px] text-muted-foreground">(unavailable)</span>
      )}
      {isDefault && (
        <span className="ml-auto text-[10px] text-muted-foreground">default</span>
      )}
    </DropdownMenuItem>
  );
}
