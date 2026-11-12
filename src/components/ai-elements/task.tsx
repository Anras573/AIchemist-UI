"use client";

import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { SearchIcon } from "lucide-react";
import type { ComponentProps } from "react";

export type TaskItemFileProps = ComponentProps<"div">;

export const TaskItemFile = ({
  children,
  className,
  ...props
}: TaskItemFileProps) => (
  <div
    className={cn(
      "inline-flex items-center gap-1 rounded-md border bg-secondary px-1.5 py-0.5 text-foreground text-xs",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<typeof TraceLine>;

export const TaskItem = ({ children, ...props }: TaskItemProps) => (
  <TraceLine {...props}>
    <TraceTitle>{children}</TraceTitle>
  </TraceLine>
);

export type TaskProps = ComponentProps<typeof TraceCollapsible>;

export const Task = ({ defaultOpen = true, ...props }: TaskProps) => (
  <Trace>
    <TraceCollapsible defaultOpen={defaultOpen} {...props} />
  </Trace>
);

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
};

export const TaskTrigger = ({
  children,
  className,
  title,
  ...props
}: TaskTriggerProps) =>
  // Custom children own their whole row (and their own chevron), so they get
  // a bare trigger. The default row is a Trace line with the standard chevron.
  children ? (
    <CollapsibleTrigger className={cn("group", className)} {...props}>
      {children}
    </CollapsibleTrigger>
  ) : (
    <TraceCollapsibleTrigger className={className} {...props}>
      <TraceLine>
        <TraceIcon>
          <SearchIcon />
        </TraceIcon>
        <TraceTitle>{title}</TraceTitle>
      </TraceLine>
    </TraceCollapsibleTrigger>
  );

export type TaskContentProps = ComponentProps<typeof TraceCollapsibleContent>;

export const TaskContent = ({ children, ...props }: TaskContentProps) => (
  <TraceCollapsibleContent keepMounted {...props}>
    <Trace>{children}</Trace>
  </TraceCollapsibleContent>
);
