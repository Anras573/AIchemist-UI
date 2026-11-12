"use client";

import type { Collapsible } from "@/components/ui/collapsible";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { cn } from "@/lib/utils";
import { BrainIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// ─── Context ──────────────────────────────────────────────────────────────────

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export function useReasoning(): ReasoningContextValue {
  const ctx = useContext(ReasoningContext);
  if (!ctx) throw new Error("useReasoning must be used within <Reasoning />");
  return ctx;
}

// ─── Reasoning (root) ─────────────────────────────────────────────────────────

export type ReasoningProps = Omit<ComponentProps<typeof Collapsible>, "onOpenChange"> & {
  isStreaming?: boolean;
  duration?: number;
  /** Called with the new open state when the panel opens or closes. */
  onOpenChange?: (open: boolean) => void;
};

export function Reasoning({
  isStreaming = false,
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  duration,
  children,
  className,
  ...props
}: ReasoningProps) {
  const [internalOpen, setInternalOpen] = useState(controlledOpen ?? defaultOpen);
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;

  const handleOpenChange = useCallback(
    (v: boolean) => {
      setInternalOpen(v);
      onOpenChange?.(v);
    },
    [onOpenChange]
  );

  // Auto-open when streaming starts, auto-close when streaming finishes
  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (isStreaming && !wasStreaming) {
      handleOpenChange(true);
    } else if (!isStreaming && wasStreaming) {
      handleOpenChange(false);
    }
  }, [isStreaming, handleOpenChange]);

  const ctx = useMemo<ReasoningContextValue>(
    () => ({ isStreaming, isOpen, setIsOpen: handleOpenChange, duration }),
    [isStreaming, isOpen, handleOpenChange, duration]
  );

  return (
    <ReasoningContext.Provider value={ctx}>
      <Trace>
        <TraceCollapsible
          open={isOpen}
          onOpenChange={handleOpenChange}
          className={className}
          {...props}
        >
          {children}
        </TraceCollapsible>
      </Trace>
    </ReasoningContext.Provider>
  );
}

Reasoning.displayName = "Reasoning";

// ─── ReasoningTrigger ─────────────────────────────────────────────────────────

export type ReasoningTriggerProps = ComponentProps<typeof TraceCollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

export function ReasoningTrigger({
  className,
  getThinkingMessage,
  ...props
}: ReasoningTriggerProps) {
  const { isStreaming, duration } = useReasoning();

  const message = getThinkingMessage
    ? getThinkingMessage(isStreaming, duration)
    : isStreaming
      ? "Thinking…"
      : duration !== undefined && duration > 0
        ? `Thought for ${duration}s`
        : "Thought for a moment";

  return (
    <TraceCollapsibleTrigger className={className} {...props}>
      <TraceLine status={isStreaming ? "running" : undefined}>
        <TraceIcon>
          <BrainIcon />
        </TraceIcon>
        <TraceTitle>{message}</TraceTitle>
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
}

ReasoningTrigger.displayName = "ReasoningTrigger";

// ─── ReasoningContent ─────────────────────────────────────────────────────────

export type ReasoningContentProps = Omit<
  ComponentProps<typeof TraceCollapsibleContent>,
  "children"
> & {
  children: string;
};

export function ReasoningContent({
  className,
  children,
  ...props
}: ReasoningContentProps) {
  return (
    <TraceCollapsibleContent
      className={cn(
        "text-xs font-mono whitespace-pre-wrap break-words",
        "max-h-64 overflow-y-auto",
        className
      )}
      {...props}
    >
      {children}
    </TraceCollapsibleContent>
  );
}

ReasoningContent.displayName = "ReasoningContent";
