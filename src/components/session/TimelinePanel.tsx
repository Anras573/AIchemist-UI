import { useEffect, useState } from "react";
import { useSessionStore, LiveToolCall, PendingApproval } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { Message as MessageRecord, CompactionEvent } from "@/types";
import { cn } from "@/lib/utils";
import { MessageResponse, Message, MessageContent } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "@/components/ai-elements/tool";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";
import { Button } from "@/components/ui/button";
import { AgentPickerButton } from "./AgentPickerButton";
import { ModelPickerButton } from "./ModelPickerButton";
import { ipc } from "@/lib/ipc";

// ─── Individual message bubble ────────────────────────────────────────────────

function MessageBubble({ message }: { message: MessageRecord }) {
  const isUser = message.role === "user";
  return (
    <Message from={message.role as "user" | "assistant"}>
      {!isUser && message.agent && (
        <span className="text-xs text-muted-foreground/70 px-1 font-medium">
          {message.agent}
        </span>
      )}
      <MessageContent className="group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground group-[.is-user]:whitespace-pre-wrap group-[.is-assistant]:bg-muted group-[.is-assistant]:rounded-lg group-[.is-assistant]:px-4 group-[.is-assistant]:py-2.5">
        {isUser ? (
          message.content
        ) : (
          <MessageResponse className="text-sm">{message.content}</MessageResponse>
        )}
      </MessageContent>
    </Message>
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
          <Shimmer className="text-sm text-muted-foreground">Thinking…</Shimmer>
        )}
      </div>
    </div>
  );
}

// ─── Tool call block ─────────────────────────────────────────────────────────

function ToolCallBlock({ call }: { call: LiveToolCall }) {
  const isPending = call.result === undefined && call.error === undefined;
  const [open, setOpen] = useState(!isPending);

  useEffect(() => {
    if (!isPending) setOpen(true);
  }, [isPending]);

  const state: ToolPart["state"] = isPending
    ? "input-available"
    : call.error
      ? "output-error"
      : "output-available";

  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[85%] w-full">
        <Tool open={open} onOpenChange={setOpen}>
          <ToolHeader type="dynamic-tool" toolName={call.toolName} state={state} />
          <ToolContent>
            <ToolInput input={call.args} />
            {!isPending && (
              <ToolOutput output={call.result} errorText={call.error} />
            )}
          </ToolContent>
        </Tool>
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

function ApprovalGate({ approval, onDecide }: ApprovalGateProps) {
  const [decision, setDecision] = useState<ApprovalDecision>("pending");
  const [scope, setScope] = useState<ApprovalScope>("once");

  function decide(approved: boolean, chosenScope: ApprovalScope) {
    setDecision(approved ? "approved" : "denied");
    setScope(chosenScope);
    onDecide(approval.approvalId, approved, chosenScope);
  }

  const isPending = decision === "pending";
  const state: ToolPart["state"] = isPending ? "approval-requested" : "approval-responded";
  const scopeLabel: Record<ApprovalScope, string> = {
    once: "once",
    session: "for this session",
    project: "for this project",
  };

  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[85%] min-w-[280px] w-full">
        <Tool defaultOpen={true}>
          <ToolHeader type="dynamic-tool" toolName={approval.toolName} state={state} />
          <ToolContent>
            {Object.keys(approval.args ?? {}).length > 0 && (
              <ToolInput input={approval.args} />
            )}
            {isPending ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => decide(true, "once")}>
                  Allow once
                </Button>
                <Button variant="outline" size="sm" onClick={() => decide(true, "session")}>
                  Allow for session
                </Button>
                <Button variant="outline" size="sm" onClick={() => decide(true, "project")}>
                  Allow for project
                </Button>
                <Button variant="destructive" size="sm" onClick={() => decide(false, "once")}>
                  Deny
                </Button>
              </div>
            ) : (
              <p className={cn(
                "text-xs font-medium",
                decision === "approved"
                  ? "text-green-600 dark:text-green-400"
                  : "text-destructive"
              )}>
                {decision === "approved" ? `Allowed ${scopeLabel[scope]}` : "Denied"}
              </p>
            )}
          </ToolContent>
        </Tool>
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
  const { sessions, activeSessionId, streamingText, liveToolCalls, pendingApprovals, removeApproval, sessionCompactions, sessionThinking, sessionIsThinking } = useSessionStore();
  const { activeProjectId } = useProjectStore();
  const session = activeSessionId ? sessions[activeSessionId] : null;
  const streaming = activeSessionId ? (streamingText[activeSessionId] ?? "") : "";
  const toolCalls = activeSessionId ? (liveToolCalls[activeSessionId] ?? []) : [];
  const approvals = activeSessionId ? (pendingApprovals[activeSessionId] ?? []) : [];
  const compactions = activeSessionId ? (sessionCompactions[activeSessionId] ?? []) : [];
  const thinkingText = activeSessionId ? (sessionThinking[activeSessionId] ?? "") : "";
  const isThinking = activeSessionId ? (sessionIsThinking[activeSessionId] ?? false) : false;
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


  // ── Empty state ────────────────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="flex flex-col h-full">
        <Conversation>
          <ConversationContent>
            <ConversationEmptyState title="No sessions yet" description="Create a new session to get started">
              {onNewSession && (
                <button
                  onClick={onNewSession}
                  className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  Create a new session
                </button>
              )}
            </ConversationEmptyState>
          </ConversationContent>
        </Conversation>
        <InputBar disabled onSend={onSendMessage} />
      </div>
    );
  }

  const messages = session.messages ?? [];

  // Build a merged, time-sorted list of messages and compaction markers
  type TimelineItem =
    | { kind: "message"; data: MessageRecord }
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
      <Conversation>
        <ConversationContent className="gap-3">
          {timelineItems.length === 0 && !streaming && (
            <ConversationEmptyState
              title="Send a message to start the conversation"
              description=""
            />
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
          {thinkingText && (
            <div className="flex w-full justify-start">
              <div className="max-w-[85%]">
                <Reasoning isStreaming={isThinking}>
                  <ReasoningTrigger />
                  <ReasoningContent>{thinkingText}</ReasoningContent>
                </Reasoning>
              </div>
            </div>
          )}
          {streaming && <StreamingBubble text={streaming} />}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

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
