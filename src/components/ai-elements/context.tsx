import { cn } from "@/lib/utils";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import type { ComponentProps, ReactNode, HTMLAttributes } from "react";
import { createContext, useContext, useMemo } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LanguageModelUsage {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface ContextValue {
  maxTokens?: number;
  usedTokens?: number;
  usage?: LanguageModelUsage;
  percentage: number;
}

const ContextCtx = createContext<ContextValue | null>(null);

function useContextValue(): ContextValue {
  const ctx = useContext(ContextCtx);
  if (!ctx) throw new Error("Context sub-components must be used inside <Context />");
  return ctx;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

// ─── Context (root) ───────────────────────────────────────────────────────────

export interface ContextProps extends ComponentProps<typeof HoverCard> {
  maxTokens?: number;
  usedTokens?: number;
  usage?: LanguageModelUsage;
  children?: ReactNode;
}

export function Context({ maxTokens, usedTokens, usage, children, ...props }: ContextProps) {
  const percentage = useMemo(() => {
    if (maxTokens == null || usedTokens == null || maxTokens === 0) return 0;
    return Math.min(1, usedTokens / maxTokens);
  }, [maxTokens, usedTokens]);

  const value = useMemo<ContextValue>(
    () => ({ maxTokens, usedTokens, usage, percentage }),
    [maxTokens, usedTokens, usage, percentage]
  );

  return (
    <ContextCtx.Provider value={value}>
      <HoverCard {...props}>
        {children}
      </HoverCard>
    </ContextCtx.Provider>
  );
}

Context.displayName = "Context";

// ─── ContextTrigger ───────────────────────────────────────────────────────────

export interface ContextTriggerProps extends ComponentProps<typeof HoverCardTrigger> {
  children?: ReactNode;
  className?: string;
}

export function ContextTrigger({ children, className, ...props }: ContextTriggerProps) {
  const { percentage, usedTokens, maxTokens } = useContextValue();

  const r = 8;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - percentage);

  const pct = maxTokens != null ? Math.round(percentage * 100) : null;
  const label = pct != null ? `${pct}%` : usedTokens != null ? formatTokens(usedTokens) : null;

  if (children) {
    return (
      <HoverCardTrigger className={className} {...props}>
        {children}
      </HoverCardTrigger>
    );
  }

  return (
    <HoverCardTrigger
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-muted-foreground",
        "hover:text-foreground hover:bg-muted/50 transition-colors cursor-default select-none",
        className
      )}
      aria-label={pct != null ? `Context window usage: ${pct}%` : usedTokens != null ? `Context window usage: ${formatTokens(usedTokens)} tokens` : "Context window usage"}
      {...props}
    >
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" className="shrink-0">
        <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" opacity={0.2} />
        <circle
          cx="10"
          cy="10"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 10 10)"
          className={cn(
            "transition-all duration-500",
            percentage >= 0.9 && "text-destructive",
            percentage >= 0.7 && percentage < 0.9 && "text-yellow-500"
          )}
        />
      </svg>
      {label && <span className="tabular-nums">{label}</span>}
    </HoverCardTrigger>
  );
}

ContextTrigger.displayName = "ContextTrigger";

// ─── ContextContent ───────────────────────────────────────────────────────────

export interface ContextContentProps extends Omit<ComponentProps<typeof HoverCardContent>, "children"> {
  children?: ReactNode;
}

export function ContextContent({ className, children, ...props }: ContextContentProps) {
  return (
    <HoverCardContent
      side="top"
      align="start"
      className={cn("w-56 p-0 overflow-hidden", className)}
      {...props}
    >
      {children}
    </HoverCardContent>
  );
}

ContextContent.displayName = "ContextContent";

// ─── ContextContentHeader ─────────────────────────────────────────────────────

export interface ContextContentHeaderProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function ContextContentHeader({ children, className, ...props }: ContextContentHeaderProps) {
  const { percentage, usedTokens, maxTokens } = useContextValue();

  if (children) {
    return <div className={cn("px-3 py-2.5 border-b border-border", className)} {...props}>{children}</div>;
  }

  const pct = maxTokens != null ? Math.round(percentage * 100) : null;

  return (
    <div className={cn("px-3 py-2.5 border-b border-border", className)} {...props}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-foreground">
          {pct != null ? `${pct}% used` : "Token usage"}
        </span>
        {usedTokens != null && maxTokens != null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatTokens(usedTokens)} / {formatTokens(maxTokens)}
          </span>
        )}
        {usedTokens != null && maxTokens == null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatTokens(usedTokens)} tokens
          </span>
        )}
      </div>
      {maxTokens != null && (
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              percentage >= 0.9 ? "bg-destructive" : percentage >= 0.7 ? "bg-yellow-500" : "bg-primary"
            )}
            style={{ width: `${Math.round(percentage * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

ContextContentHeader.displayName = "ContextContentHeader";

// ─── ContextContentBody ───────────────────────────────────────────────────────

export interface ContextContentBodyProps extends ComponentProps<"div"> {
  children?: ReactNode;
}

export function ContextContentBody({ children, className, ...props }: ContextContentBodyProps) {
  return (
    <div className={cn("px-3 py-2 flex flex-col gap-1", className)} {...props}>
      {children}
    </div>
  );
}

ContextContentBody.displayName = "ContextContentBody";

// ─── ContextContentFooter ─────────────────────────────────────────────────────

export interface ContextContentFooterProps extends ComponentProps<"div"> {
  children?: ReactNode;
}

export function ContextContentFooter({ children, className, ...props }: ContextContentFooterProps) {
  if (!children) return null;
  return (
    <div className={cn("px-3 py-2 border-t border-border bg-muted/40", className)} {...props}>
      {children}
    </div>
  );
}

ContextContentFooter.displayName = "ContextContentFooter";

// ─── Shared usage row ─────────────────────────────────────────────────────────

interface UsageRowProps extends ComponentProps<"div"> {
  label: string;
  tokens: number;
  children?: ReactNode;
}

function UsageRow({ label, tokens, children, className, ...props }: UsageRowProps) {
  if (children) {
    return <div className={cn("flex items-center justify-between text-xs", className)} {...props}>{children}</div>;
  }
  return (
    <div className={cn("flex items-center justify-between text-xs", className)} {...props}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{formatTokens(tokens)}</span>
    </div>
  );
}

// ─── ContextInputUsage ────────────────────────────────────────────────────────

export interface ContextInputUsageProps extends ComponentProps<"div"> {
  children?: ReactNode;
}

export function ContextInputUsage({ children, ...props }: ContextInputUsageProps) {
  const { usage } = useContextValue();
  if (!usage) return null;
  return <UsageRow label="Input" tokens={usage.inputTokens} {...props}>{children}</UsageRow>;
}

ContextInputUsage.displayName = "ContextInputUsage";

// ─── ContextOutputUsage ───────────────────────────────────────────────────────

export interface ContextOutputUsageProps extends ComponentProps<"div"> {
  children?: ReactNode;
}

export function ContextOutputUsage({ children, ...props }: ContextOutputUsageProps) {
  const { usage } = useContextValue();
  if (!usage) return null;
  return <UsageRow label="Output" tokens={usage.outputTokens} {...props}>{children}</UsageRow>;
}

ContextOutputUsage.displayName = "ContextOutputUsage";

// ─── ContextReasoningUsage ────────────────────────────────────────────────────

export interface ContextReasoningUsageProps extends ComponentProps<"div"> {
  children?: ReactNode;
}

export function ContextReasoningUsage({ children, ...props }: ContextReasoningUsageProps) {
  const { usage } = useContextValue();
  if (!usage || usage.reasoningTokens === 0) return null;
  return <UsageRow label="Reasoning" tokens={usage.reasoningTokens} {...props}>{children}</UsageRow>;
}

ContextReasoningUsage.displayName = "ContextReasoningUsage";

// ─── ContextCacheUsage ────────────────────────────────────────────────────────

export interface ContextCacheUsageProps extends ComponentProps<"div"> {
  children?: ReactNode;
}

export function ContextCacheUsage({ children, ...props }: ContextCacheUsageProps) {
  const { usage } = useContextValue();
  if (!usage || usage.cachedInputTokens === 0) return null;
  return <UsageRow label="Cached" tokens={usage.cachedInputTokens} {...props}>{children}</UsageRow>;
}

ContextCacheUsage.displayName = "ContextCacheUsage";
