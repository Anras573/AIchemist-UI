import type { ReactElement, ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface WithTooltipProps {
  /** The trigger element. Must accept the standard DOM props Base UI forwards. */
  children: ReactElement;
  /** Tooltip body — string or rich content. */
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /** Tooltip alignment along the chosen side. */
  align?: "start" | "center" | "end";
}

/**
 * Lightweight wrapper around the Base UI Tooltip primitives. Use to add a
 * hover hint to any interactive control without the per-site boilerplate.
 *
 *   <WithTooltip label="Close session">
 *     <button aria-label="Close session" onClick={…}>×</button>
 *   </WithTooltip>
 *
 * Pair `label` with an `aria-label` (or visible text) on the child so the
 * control remains accessible to screen readers and discoverable in tests.
 */
export function WithTooltip({
  children,
  label,
  side = "top",
  align = "center",
}: WithTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} align={align}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
