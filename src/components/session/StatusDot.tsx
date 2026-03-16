import { SessionStatus } from "@/types";
import { cn } from "@/lib/utils";

interface StatusDotProps {
  status: SessionStatus;
  className?: string;
}

export function StatusDot({ status, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        "inline-block w-2 h-2 rounded-full flex-shrink-0",
        status === "running" && "bg-green-500 animate-pulse",
        status === "waiting_approval" && "bg-amber-400",
        status === "error" && "bg-red-500",
        (status === "idle" || status === "complete") && "bg-muted-foreground/30",
        className
      )}
      title={status}
    />
  );
}
