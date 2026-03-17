import { useEffect, useRef } from "react";
import { useSessionStore, LiveToolCall, PendingApproval } from "@/lib/store/useSessionStore";
import { Message } from "@/types";
import { cn } from "@/lib/utils";
import { MessageResponse } from "@/components/ai-elements/message";

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

interface ApprovalGateProps {
  approval: PendingApproval;
  onDecide: (approvalId: string, approved: boolean) => void;
}

function ApprovalGate({ approval, onDecide }: ApprovalGateProps) {
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[85%] rounded-lg border border-amber-400/50 bg-background text-xs font-mono overflow-hidden shadow-sm">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-400/10 border-b border-amber-400/30">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
          <span className="text-amber-600 dark:text-amber-400 font-sans text-[11px] font-medium">
            approval required
          </span>
          <span className="font-semibold text-foreground">{approval.toolName}</span>
        </div>

        {/* Tool arguments */}
        <div className="px-3 py-2 text-muted-foreground border-b border-amber-400/20">
          <pre className="whitespace-pre-wrap break-all">
            {JSON.stringify(approval.args, null, 2)}
          </pre>
        </div>

        {/* Allow / Deny buttons */}
        <div className="flex gap-2 px-3 py-2 bg-muted/30">
          <button
            onClick={() => onDecide(approval.approvalId, true)}
            className={cn(
              "flex-1 rounded px-3 py-1 text-xs font-sans font-medium transition-colors",
              "bg-green-500/15 text-green-700 dark:text-green-400 hover:bg-green-500/30",
              "border border-green-500/30"
            )}
          >
            Allow
          </button>
          <button
            onClick={() => onDecide(approval.approvalId, false)}
            className={cn(
              "flex-1 rounded px-3 py-1 text-xs font-sans font-medium transition-colors",
              "bg-destructive/10 text-destructive hover:bg-destructive/20",
              "border border-destructive/30"
            )}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

interface TimelinePanelProps {
  /** Called by Phase 4 when the user submits a message. */
  onSendMessage?: (text: string) => void;
}

export function TimelinePanel({ onSendMessage }: TimelinePanelProps) {
  const { sessions, activeSessionId, streamingText, liveToolCalls, pendingApprovals, resolveApproval } = useSessionStore();
  const session = activeSessionId ? sessions[activeSessionId] : null;
  const streaming = activeSessionId ? (streamingText[activeSessionId] ?? "") : "";
  const toolCalls = activeSessionId ? (liveToolCalls[activeSessionId] ?? []) : [];
  const approvals = activeSessionId ? (pendingApprovals[activeSessionId] ?? []) : [];
  const isRunning = session?.status === "running" || session?.status === "waiting_approval";

  function handleApprovalDecision(approvalId: string, approved: boolean) {
    if (!activeSessionId) return;
    resolveApproval(activeSessionId, approvalId, approved);
    // If all approvals resolved, status reverts to running inside the agent loop
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
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Select a session or press <kbd className="mx-1.5 px-1.5 py-0.5 rounded border bg-muted text-xs font-mono">+</kbd> to start a new one
        </div>
        <InputBar disabled onSend={onSendMessage} />
      </div>
    );
  }

  const messages = session.messages ?? [];

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && !streaming && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Send a message to start the conversation
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
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
      <p className="mt-1.5 text-xs text-muted-foreground/60">
        Enter to send · Shift+Enter for new line
      </p>
    </div>
  );
}
