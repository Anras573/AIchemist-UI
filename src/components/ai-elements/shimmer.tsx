"use client";

import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { memo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  /** Seconds for one sweep. */
  duration?: number;
  /** Width of the highlight in px (previously scaled by text length). */
  spread?: number;
}

/**
 * Animated "working" text. Pure CSS: the `shimmer` utility comes from
 * `shadcn/tailwind.css`, so there is no JS animation loop.
 */
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread,
}: TextShimmerProps) => (
  <Component
    className={cn(
      "inline-block shimmer motion-reduce:shimmer-none",
      className
    )}
    style={
      {
        "--shimmer-duration": `${duration}s`,
        ...(spread === undefined
          ? {}
          : { "--shimmer-spread": `${spread * (children?.length ?? 0)}px` }),
      } as CSSProperties
    }
  >
    {children}
  </Component>
);

export const Shimmer = memo(ShimmerComponent);
