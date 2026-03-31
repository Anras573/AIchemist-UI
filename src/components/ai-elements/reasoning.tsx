"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
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
      <Collapsible
        open={isOpen}
        onOpenChange={handleOpenChange}
        className={cn("w-full", className)}
        {...props}
      >
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  );
}

Reasoning.displayName = "Reasoning";

// ─── ReasoningTrigger ─────────────────────────────────────────────────────────

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

export function ReasoningTrigger({
  className,
  getThinkingMessage,
  ...props
}: ReasoningTriggerProps) {
  const { isStreaming, isOpen, duration } = useReasoning();

  const message = getThinkingMessage
    ? getThinkingMessage(isStreaming, duration)
    : isStreaming
      ? "Thinking…"
      : "Thought for a moment";

  return (
    <CollapsibleTrigger
      className={cn(
        "flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 select-none",
        className
      )}
      {...props}
    >
      <BrainIcon className="size-3.5 shrink-0" />
      <span>{message}</span>
      {isStreaming && (
        <span className="flex gap-0.5 items-center ml-1">
          <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:0ms]" />
          <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:150ms]" />
          <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:300ms]" />
        </span>
      )}
      <ChevronDownIcon
        className={cn(
          "size-3.5 shrink-0 transition-transform duration-200 ml-1",
          isOpen && "rotate-180"
        )}
      />
    </CollapsibleTrigger>
  );
}

ReasoningTrigger.displayName = "ReasoningTrigger";

// ─── ReasoningContent ─────────────────────────────────────────────────────────

export type ReasoningContentProps = Omit<
  ComponentProps<typeof CollapsibleContent>,
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
    <CollapsibleContent
      className={cn(
        "mt-1 border-l-2 border-muted-foreground/20 pl-3 py-1",
        "text-xs text-muted-foreground font-mono whitespace-pre-wrap break-words",
        "max-h-64 overflow-y-auto",
        "data-[state=closed]:animate-out data-[state=open]:animate-in",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    >
      {children}
    </CollapsibleContent>
  );
}

ReasoningContent.displayName = "ReasoningContent";
