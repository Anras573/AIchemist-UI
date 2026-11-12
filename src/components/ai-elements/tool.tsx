"use client";

import { Badge } from "@/components/ui/badge";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockLine,
} from "@/components/ui/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { useHighlightedCode } from "@/lib/hooks/useHighlightedCode";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  CircleAlertIcon,
  CircleIcon,
  ClockIcon,
  LoaderCircleIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

export type ToolProps = ComponentProps<typeof TraceCollapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Trace className="not-prose mb-4">
    <TraceCollapsible className={className} {...props} />
  </Trace>
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};

/**
 * Kept exported for callers that still want a status badge, even though the
 * Trace-based `ToolHeader` below no longer renders one.
 */
export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

type TraceStatus = "running" | "error" | "pending" | undefined;

/** Maps a tool part's state to the Trace line status and title. */
function describeState(
  state: ToolPart["state"],
  name: string
): { status: TraceStatus; title: string } {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return { status: "running", title: `Running ${name}` };
    case "output-available":
      return { status: undefined, title: `Ran ${name}` };
    case "output-error":
      return { status: "error", title: `Failed to run ${name}` };
    case "output-denied":
      return { status: undefined, title: `Denied ${name}` };
    case "approval-requested":
      return { status: "pending", title: `Awaiting approval to run ${name}` };
    case "approval-responded":
      return { status: undefined, title: `Reviewed ${name}` };
  }
}

function StateIcon({ state }: { state: ToolPart["state"] }) {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return <LoaderCircleIcon className="animate-spin" />;
    case "output-error":
      return <CircleAlertIcon />;
    case "output-denied":
      return <XCircleIcon />;
    case "approval-requested":
      return <ClockIcon />;
    default:
      return <WrenchIcon />;
  }
}

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  const { status, title: stateTitle } = describeState(
    state,
    title ?? derivedName
  );

  return (
    <TraceCollapsibleTrigger className={className} {...props}>
      <TraceLine status={status}>
        <TraceIcon>
          <StateIcon state={state} />
        </TraceIcon>
        <TraceTitle>{stateTitle}</TraceTitle>
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof TraceCollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <TraceCollapsibleContent
    className={cn("space-y-3", className)}
    {...props}
  />
);

function HighlightedBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const lines = useHighlightedCode(code, language);

  return (
    <CodeBlock size="sm">
      <CodeBlockContent wrap className="max-h-64">
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <HighlightedBlock code={JSON.stringify(input, null, 2)} language="json" />
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <HighlightedBlock
        code={JSON.stringify(output, null, 2)}
        language="json"
      />
    );
  } else if (typeof output === "string") {
    Output = <HighlightedBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText ? "text-destructive" : "text-foreground"
        )}
      >
        {errorText && (
          <div className="rounded-md bg-destructive/10 p-2">{errorText}</div>
        )}
        {Output}
      </div>
    </div>
  );
};
