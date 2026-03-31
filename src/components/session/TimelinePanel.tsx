import { useEffect, useRef, useState } from "react";
import { useSessionStore, LiveToolCall, PendingApproval } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { Message, CompactionEvent } from "@/types";
import { cn } from "@/lib/utils";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationActions,
  ConfirmationAction,
} from "@/components/ai-elements/confirmation";
import { CheckIcon, XIcon } from "lucide-react";
import { AgentPickerButton } from "./AgentPickerButton";
import { ModelPickerButton } from "./ModelPickerButton";
import { ipc } from "@/lib/ipc";

// ─── Individual message bubble ────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-4 py-2.5 text-sm",
          isUser
            ? "bg-primary text-primary-foreground whitespace-pre-wrap"
            : "bg-muted text-foreground"
        )}
      >
        {isUser ? (
          message.content
        ) : (
          <MessageResponse className="text-sm">{message.content}</MessageResponse>
        )}
      </div>
    </div>
  );
}

// ─── Streaming indicator ──────────────────────────────────────────────────────

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[80%] rounded-lg px-4 py-2.5 text-sm bg-muted text-foreground">
        {text ? (
          <MessageResponse className="text-sm">{text}</MessageResponse>
        ) : (
          <span className="flex gap-1 items-center h-4">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Tool call block ─────────────────────────────────────────────────────────

function ToolCallBlock({ call }: { call: LiveToolCall }) {
  const isPending = call.result === undefined && call.error === undefined;

  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[85%] rounded-lg border bg-background text-xs font-mono overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-b">
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full flex-shrink-0",
              isPending
                ? "bg-amber-400 animate-pulse"
                : call.error
                  ? "bg-destructive"
                  : "bg-green-500"
            )}
          />
          <span className="text-muted-foreground font-sans text-[11px]">
            {isPending ? "calling" : call.error ? "error" : "result"}
          </span>
          <span className="font-semibold text-foreground">{call.toolName}</span>
        </div>

        {/* Arguments */}
        <div className="px-3 py-2 text-muted-foreground border-b">
          <pre className="whitespace-pre-wrap break-all">
            {JSON.stringify(call.args, null, 2)}
          </pre>
        </div>

        {/* Result / error */}
        {!isPending && (
          <div
            className={cn(
              "px-3 py-2",
              call.error ? "text-destructive" : "text-foreground"
            )}
          >
            <pre className="whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
              {call.error
                ? call.error
                : JSON.stringify(call.result, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Approval gate ────────────────────────────────────────────────────────────

type ApprovalScope = "once" | "session" | "project";
type ApprovalDecision = "pending" | "approved" | "denied";

interface ApprovalGateProps {
  approval: PendingApproval;
  onDecide: (approvalId: string, approved: boolean, scope: ApprovalScope) => void;
}

/** Formats a single arg value for display — strings truncated, objects as compact JSON. */
function formatArgValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function ApprovalGate({ approval, onDecide }: ApprovalGateProps) {
  const [decision, setDecision] = useState<ApprovalDecision>("pending");
  const [scope, setScope] = useState<ApprovalScope>("once");

  function decide(approved: boolean, chosenScope: ApprovalScope) {
    setDecision(approved ? "approved" : "denied");
    setScope(chosenScope);
    onDecide(approval.approvalId, approved, chosenScope);
  }

  const confirmApproval =
    decision === "pending"
      ? { id: approval.approvalId }
      : { id: approval.approvalId, approved: decision === "approved" };

  const confirmState =
    decision === "pending" ? "approval-requested" : "approval-responded";

  const argEntries = Object.entries(approval.args ?? {});
  const scopeLabel: Record<ApprovalScope, string> = {
    once: "once",
    session: "for this session",
    project: "for this project",
  };

  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[85%] min-w-[280px]">
        <Confirmation
          approval={confirmApproval}
          state={confirmState}
          className="text-sm border-amber-400/50 bg-amber-400/10 dark:bg-amber-400/5"
        >
          <ConfirmationTitle className="flex items-center gap-2 font-semibold text-foreground">
            <span className="inline-block size-1.5 shrink-0 rounded-full bg-amber-500 animate-pulse" />
            {approval.toolName}
          </ConfirmationTitle>

          {/* Args — only shown while pending */}
          <ConfirmationRequest>
            {argEntries.length > 0 && (
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs font-mono">
                {argEntries.map(([key, val]) => (
                  <div key={key} className="contents">
                    <dt className="text-muted-foreground truncate">{key}</dt>
                    <dd className="text-foreground break-all">{formatArgValue(val)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </ConfirmationRequest>

          <ConfirmationAccepted>
            <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
              <CheckIcon className="size-3.5" />
              Allowed {scopeLabel[scope]}
            </span>
          </ConfirmationAccepted>

          <ConfirmationRejected>
            <span className="flex items-center gap-1.5 text-xs text-destructive">
              <XIcon className="size-3.5" />
              Denied
            </span>
          </ConfirmationRejected>

          <ConfirmationActions className="flex-wrap justify-start">
            <ConfirmationAction variant="outline" size="sm" onClick={() => decide(true, "once")}>
              Allow once
            </ConfirmationAction>
            <ConfirmationAction variant="outline" size="sm" onClick={() => decide(true, "session")}>
              Allow for session
            </ConfirmationAction>
            <ConfirmationAction variant="outline" size="sm" onClick={() => decide(true, "project")}>
              Allow for project
            </ConfirmationAction>
            <ConfirmationAction
              variant="destructive"
              size="sm"
              onClick={() => decide(false, "once")}
            >
              Deny
            </ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      </div>
    </div>
  );
}

// ─── Compaction marker ────────────────────────────────────────────────────────

function CompactionMarker({ event }: { event: CompactionEvent }) {
  const tokens = event.pre_tokens > 0
    ? `${Math.round(event.pre_tokens / 1000)}k tokens summarised`
    : "context summarised";
  return (
    <div className="flex items-center gap-2 py-1 select-none" aria-label="Conversation compacted">
      <div className="flex-1 h-px bg-border" />
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap px-1">
        <span>🗜</span>
        <span>Conversation compacted · {tokens}</span>
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}



interface TimelinePanelProps {
  /** Called by Phase 4 when the user submits a message. */
  onSendMessage?: (text: string) => void;
  /** Called when the user clicks "Create new session" from the empty state. */
  onNewSession?: () => void;
}

export function TimelinePanel({ onSendMessage, onNewSession }: TimelinePanelProps) {
  const { sessions, activeSessionId, streamingText, liveToolCalls, pendingApprovals, removeApproval, sessionCompactions } = useSessionStore();
  const { activeProjectId } = useProjectStore();
  const session = activeSessionId ? sessions[activeSessionId] : null;
  const streaming = activeSessionId ? (streamingText[activeSessionId] ?? "") : "";
  const toolCalls = activeSessionId ? (liveToolCalls[activeSessionId] ?? []) : [];
  const approvals = activeSessionId ? (pendingApprovals[activeSessionId] ?? []) : [];
  const compactions = activeSessionId ? (sessionCompactions[activeSessionId] ?? []) : [];
  const isRunning = session?.status === "running" || session?.status === "waiting_approval";

  function handleApprovalDecision(approvalId: string, approved: boolean, scope: "once" | "session" | "project") {
    if (!activeSessionId) return;
    const approval = approvals.find((a) => a.approvalId === approvalId);
    if (!approval) return;
    // Unblock the agent immediately
    approval.resolve(approved, { scope, projectId: activeProjectId ?? undefined });
    // Remove the card after a brief feedback window
    const sid = activeSessionId;
    setTimeout(() => removeApproval(sid, approvalId), 1500);
  }

  // Auto-scroll to bottom when messages or streaming text changes
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages.length, streaming, toolCalls.length, approvals.length]);

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <p className="text-sm">No sessions yet for this project.</p>
          {onNewSession && (
            <button
              onClick={onNewSession}
              className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Create a new session
            </button>
          )}
        </div>
        <InputBar disabled onSend={onSendMessage} />
      </div>
    );
  }

  const messages = session.messages ?? [];

  // Build a merged, time-sorted list of messages and compaction markers
  type TimelineItem =
    | { kind: "message"; data: Message }
    | { kind: "compaction"; data: CompactionEvent };

  const timelineItems: TimelineItem[] = [
    ...messages.map((m): TimelineItem => ({ kind: "message", data: m })),
    ...compactions.map((c): TimelineItem => ({ kind: "compaction", data: c })),
  ].sort((a, b) => {
    const ta = a.kind === "message" ? a.data.created_at : a.data.timestamp;
    const tb = b.kind === "message" ? b.data.created_at : b.data.timestamp;
    return ta.localeCompare(tb);
  });

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {timelineItems.length === 0 && !streaming && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Send a message to start the conversation
          </div>
        )}
        {timelineItems.map((item) =>
          item.kind === "message" ? (
            <MessageBubble key={item.data.id} message={item.data} />
          ) : (
            <CompactionMarker key={item.data.id} event={item.data} />
          )
        )}
        {toolCalls.map((call) => (
          <ToolCallBlock key={call.toolCallId} call={call} />
        ))}
        {approvals.map((approval) => (
          <ApprovalGate
            key={approval.approvalId}
            approval={approval}
            onDecide={handleApprovalDecision}
          />
        ))}
        {streaming && <StreamingBubble text={streaming} />}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <InputBar
        disabled={isRunning}
        placeholder={isRunning ? "Waiting for response…" : "Send a message…"}
        onSend={onSendMessage}
      />
    </div>
  );
}

// ─── Input bar ────────────────────────────────────────────────────────────────

interface InputBarProps {
  disabled?: boolean;
  placeholder?: string;
  onSend?: (text: string) => void;
}

function InputBar({ disabled, placeholder = "Send a message…", onSend }: InputBarProps) {
  const { sessions, activeSessionId } = useSessionStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const activeProject = activeProjectId ? projects.find((p) => p.id === activeProjectId) : null;

  const [gitBranch, setGitBranch] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProject?.path) { setGitBranch(null); return; }
    ipc.getGitBranch(activeProject.path).then(setGitBranch).catch(() => setGitBranch(null));
  }, [activeProject?.path]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = e.currentTarget.value.trim();
      if (text && onSend) {
        onSend(text);
        e.currentTarget.value = "";
      }
    }
  }

  return (
    <div className="border-t p-3 flex-shrink-0">
      <textarea
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full resize-none rounded-md border bg-background px-3 py-2 text-sm",
          "focus:outline-none focus:ring-1 focus:ring-ring",
          "placeholder:text-muted-foreground",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "min-h-[38px] max-h-40 overflow-y-auto"
        )}
      />
      <div className="mt-1.5 flex items-center gap-2">
        {activeSession && (
          <ModelPickerButton
            sessionId={activeSession.id}
            provider={activeSession.provider}
            model={activeSession.model}
          />
        )}
        <AgentPickerButton />
        {gitBranch && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground/60">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M11.75 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm.75 2.25a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM4.25 13.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM5 15.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM4.25 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM5 4.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM5.75 8A3.25 3.25 0 0 0 9 11.25v.5a2.25 2.25 0 1 0 1.5 0v-.5a4.75 4.75 0 0 1-4.75-4.75v-.5a2.25 2.25 0 1 0-1.5 0v.5A3.25 3.25 0 0 0 5.75 8Z"/>
            </svg>
            {gitBranch}
          </span>
        )}
        <p className="text-xs text-muted-foreground/60 ml-auto">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
