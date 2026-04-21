import { SessionStatus } from "@/types";
import { cn } from "@/lib/utils";
import { WithTooltip } from "@/components/ui/with-tooltip";

interface StatusDotProps {
  status: SessionStatus;
  className?: string;
}

export function StatusDot({ status, className }: StatusDotProps) {
  return (
    <WithTooltip label={status}>
      <span
        aria-label={status}
        className={cn(
          "inline-block w-2 h-2 rounded-full flex-shrink-0",
          status === "running" && "bg-green-500 animate-pulse",
          status === "waiting_approval" && "bg-amber-400",
          status === "error" && "bg-red-500",
          (status === "idle" || status === "complete") && "bg-muted-foreground/30",
          className
        )}
      />
    </WithTooltip>
  );
}
