import { memo, useEffect, useMemo, useState } from "react";
import { useSessionStore, LiveToolCall, PendingApproval } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { Message as MessageRecord, CompactionEvent } from "@/types";
import { cn } from "@/lib/utils";
import { useProviderProbes } from "@/lib/hooks/useProviderProbes";
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
import { EmptyStateNewSession } from "./EmptyStateNewSession";
import { InputBar } from "./InputBar";
import { QuestionCard } from "./QuestionCard";
import { useIpc } from "@/lib/ipc";

const EMPTY_COMPACTIONS: CompactionEvent[] = [];

// ─── Individual message bubble ────────────────────────────────────────────────

const MessageBubble = memo(function MessageBubble({
  message,
  isQueued,
}: {
  message: MessageRecord;
  isQueued?: boolean;
}) {
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
      {isQueued && (
        <span className="self-end text-[10px] font-medium text-muted-foreground/60 px-1 py-0.5 rounded bg-muted/60 border border-border/50 select-none">
          Queued
        </span>
      )}
    </Message>
  );
});

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

const ToolCallBlock = memo(function ToolCallBlock({ call }: { call: LiveToolCall }) {
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
});

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
                {decision === "approved"
                  ? `Allowed ${scopeLabel[scope]}`
                  : "Denied"}
              </p>
            )}
          </ToolContent>
        </Tool>
      </div>
    </div>
  );
}

// ─── Compaction marker ────────────────────────────────────────────────────────

const CompactionMarker = memo(function CompactionMarker({ event }: { event: CompactionEvent }) {
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
});

// ─── Queue recovery card ──────────────────────────────────────────────────────

function QueueRecoveryCard({
  remainingCount,
  onAction,
}: {
  remainingCount: number;
  onAction: (action: "retry" | "skip" | "clear") => void;
}) {
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[85%] rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm space-y-2">
        <p className="font-medium text-destructive">A queued message failed to send.</p>
        <p className="text-xs text-muted-foreground">
          {remainingCount} message{remainingCount !== 1 ? "s" : ""} still in queue. Choose how to continue:
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => onAction("retry")}>
            Retry
          </Button>
          <Button variant="outline" size="sm" onClick={() => onAction("skip")}>
            Skip
          </Button>
          <Button variant="outline" size="sm" onClick={() => onAction("clear")}>
            Clear queue
          </Button>
        </div>
      </div>
    </div>
  );
}



interface TimelinePanelProps {
  /** Called by Phase 4 when the user submits a message. */
  onSendMessage?: (text: string, oneshotSkills?: string[]) => void;
  /** Called when the user clicks "Create new session" from the empty state. Optional provider override locks the new session provider. */
  onNewSession?: (providerOverride?: string, issueNumber?: number) => void;
  /** Error message from a failed session creation attempt, to surface in the empty state. */
  createSessionError?: string | null;
  /** Project path — used for the issue picker in the empty state. */
  projectPath?: string;
}

export function TimelinePanel({ onSendMessage, onNewSession, createSessionError, projectPath }: TimelinePanelProps) {
  const ipc = useIpc();
  const { sessions, activeSessionId, streamingText, liveToolCalls, pendingApprovals, pendingQuestions, removeApproval, removePendingQuestion, sessionCompactions, sessionThinking, sessionIsThinking, queuedMessageIds, queuePaused, clearQueuePaused, clearQueuedMessages, dequeueMessage } = useSessionStore();
  const { activeProjectId, projects } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const defaultProvider = activeProject?.config.provider ?? null;
  const { probes } = useProviderProbes(activeProjectId ?? undefined);
  const session = activeSessionId ? sessions[activeSessionId] : null;
  const streaming = activeSessionId ? (streamingText[activeSessionId] ?? "") : "";
  const toolCalls = activeSessionId ? (liveToolCalls[activeSessionId] ?? []) : [];
  const approvals = activeSessionId ? (pendingApprovals[activeSessionId] ?? []) : [];
  const questions = activeSessionId ? (pendingQuestions[activeSessionId] ?? []) : [];
  const compactions = activeSessionId
    ? (sessionCompactions[activeSessionId] ?? EMPTY_COMPACTIONS)
    : EMPTY_COMPACTIONS;
  const thinkingText = activeSessionId ? (sessionThinking[activeSessionId] ?? "") : "";
  const isThinking = activeSessionId ? (sessionIsThinking[activeSessionId] ?? false) : false;
  const isRunning = session?.status === "running" || session?.status === "waiting_approval";
  const queuedIdsSet = useMemo(
    () => new Set(activeSessionId ? (queuedMessageIds[activeSessionId] ?? []) : []),
    [queuedMessageIds, activeSessionId]
  );
  const queuePausedState = activeSessionId ? (queuePaused[activeSessionId] ?? null) : null;

  const messages = session?.messages ?? [];

  // Build a merged, time-sorted list of messages and compaction markers.
  // Declared here (before early returns) to satisfy Rules of Hooks.
  type TimelineItem =
    | { kind: "message"; data: MessageRecord }
    | { kind: "compaction"; data: CompactionEvent };

  const timelineItems: TimelineItem[] = useMemo(() => {
    return [
      ...messages.map((m): TimelineItem => ({ kind: "message", data: m })),
      ...compactions.map((c): TimelineItem => ({ kind: "compaction", data: c })),
    ].sort((a, b) => {
      const ta = a.kind === "message" ? a.data.created_at : a.data.timestamp;
      const tb = b.kind === "message" ? b.data.created_at : b.data.timestamp;
      return ta.localeCompare(tb);
    });
  }, [messages, compactions]);

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

  function handleQueueRecovery(action: "retry" | "skip" | "clear") {
    if (!activeSessionId) return;
    const sid = activeSessionId;
    const failedMsgId = queuePaused[sid]?.failedMessageId;
    ipc.agentQueueRecovery(sid, action)
      .then(() => {
        clearQueuePaused(sid);
        if (action === "clear") {
          clearQueuedMessages(sid);
        } else if (action === "skip" && failedMsgId) {
          dequeueMessage(sid, failedMsgId);
        }
      })
      .catch(console.error);
  }


  // ── Empty state ────────────────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="flex flex-col h-full">
        <Conversation>
          <ConversationContent>
            <ConversationEmptyState title="No sessions yet" description="Create a new session to get started">
              {onNewSession && (
                <EmptyStateNewSession
                  defaultProvider={defaultProvider}
                  onNewSession={onNewSession}
                  probes={probes}
                  error={createSessionError}
                  projectPath={projectPath}
                />
              )}
            </ConversationEmptyState>
          </ConversationContent>
        </Conversation>
        <InputBar disabled onSend={onSendMessage} onNewSession={onNewSession} />
      </div>
    );
  }


  return (
    <div className="flex flex-col h-full">
      <Conversation>
        <ConversationContent className="gap-3">
          {timelineItems.length === 0 && session?.status !== "running" && (
            <ConversationEmptyState
              title="Send a message to start the conversation"
              description=""
            />
          )}
          {timelineItems.map((item) =>
            item.kind === "message" ? (
              <MessageBubble
                key={item.data.id}
                message={item.data}
                isQueued={queuedIdsSet.has(item.data.id)}
              />
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
          {questions.map((q) => (
            <QuestionCard
              key={q.questionId}
              question={q}
              onAnswer={(questionId, answer) => {
                if (!activeSessionId) return;
                q.resolve(answer);
                removePendingQuestion(activeSessionId, questionId);
              }}
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
          {session?.status === "running" && <StreamingBubble text={streaming} />}
          {queuePausedState && (
            <QueueRecoveryCard
              remainingCount={queuePausedState.remainingCount}
              onAction={handleQueueRecovery}
            />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Queue hint — shown when agent is busy so user knows messages will be queued */}
      {isRunning && (
        <div className="px-4 py-1.5 text-xs text-muted-foreground border-t bg-muted/30 select-none">
          Agent is busy — your message will be queued
        </div>
      )}
      {/* Input bar */}
      <InputBar
        placeholder="Send a message…"
        onSend={onSendMessage}
        onNewSession={onNewSession}
      />
    </div>
  );
}
