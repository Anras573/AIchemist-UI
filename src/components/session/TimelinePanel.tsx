import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Virtuoso } from "react-virtuoso";
import { useSessionStore, LiveToolCall, PendingApproval, PendingQuestion } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { Message as MessageRecord, CompactionEvent } from "@/types";
import type { Provider } from "@/types";
import { cn } from "@/lib/utils";
import { useProviderProbes } from "@/lib/hooks/useProviderProbes";
import { MessageResponse, Message, MessageContent } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { ArrowDownIcon } from "lucide-react";
import {
  ConversationEmptyState,
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
import { EmptyStateNewSession } from "./EmptyStateNewSession";
import { InputBar } from "./InputBar";
import { QuestionCard } from "./QuestionCard";
import { useIpc } from "@/lib/ipc";
import { useLoadOlderMessages } from "@/lib/hooks/useLoadOlderMessages";

const EMPTY_COMPACTIONS: CompactionEvent[] = [];
const EMPTY_TOOL_CALLS: LiveToolCall[] = [];
const EMPTY_APPROVALS: PendingApproval[] = [];
const EMPTY_QUESTIONS: PendingQuestion[] = [];
const EMPTY_QUEUED_IDS: string[] = [];

// Starting value for Virtuoso's `firstItemIndex` — react-virtuoso's documented
// pattern for prepending items to the top of the list without a scroll jump.
// It only needs to stay comfortably above 0 as older pages are prepended
// (each prepend decrements it by the page size), so an arbitrary large value
// works; it has no other meaning (not a real message index).
const FIRST_ITEM_INDEX_START = 10_000_000;

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

// ─── Timeline item (virtualized) ───────────────────────────────────────────────

type TimelineItem =
  | { kind: "message"; data: MessageRecord }
  | { kind: "compaction"; data: CompactionEvent };

// ─── Timeline footer (live, non-virtualized turn state) ───────────────────────
//
// Rendered by react-virtuoso's `Footer` slot, right after the virtualized
// historical items — so it's a normal part of the same scrollable area. It's
// passed as `context` (not props) so the `Footer` component reference itself
// stays stable across renders; changing the `components` object on every
// render would make Virtuoso remount the whole list.

interface TimelineFooterContext {
  showEmptyState: boolean;
  toolCalls: LiveToolCall[];
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  thinkingText: string;
  isThinking: boolean;
  showStreamingBubble: boolean;
  streaming: string;
  queuePausedState: { remainingCount: number; failedMessageId?: string } | null;
  activeSessionId: string | null;
  handleApprovalDecision: (approvalId: string, approved: boolean, scope: ApprovalScope) => void;
  removePendingQuestion: (sessionId: string, questionId: string) => void;
  handleQueueRecovery: (action: "retry" | "skip" | "clear") => void;
}

function TimelineFooter({ context }: { context?: TimelineFooterContext }) {
  if (!context) return null;
  const {
    showEmptyState,
    toolCalls,
    approvals,
    questions,
    thinkingText,
    isThinking,
    showStreamingBubble,
    streaming,
    queuePausedState,
    activeSessionId,
    handleApprovalDecision,
    removePendingQuestion,
    handleQueueRecovery,
  } = context;

  return (
    <div className="flex flex-col gap-3 px-4 pt-3 pb-4">
      {showEmptyState && (
        <ConversationEmptyState title="Send a message to start the conversation" description="" />
      )}
      {toolCalls.map((call) => (
        <ToolCallBlock key={call.toolCallId} call={call} />
      ))}
      {approvals.map((approval) => (
        <ApprovalGate key={approval.approvalId} approval={approval} onDecide={handleApprovalDecision} />
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
      {showStreamingBubble && <StreamingBubble text={streaming} />}
      {queuePausedState && (
        <QueueRecoveryCard remainingCount={queuePausedState.remainingCount} onAction={handleQueueRecovery} />
      )}
    </div>
  );
}

interface TimelinePanelProps {
  /** Called by Phase 4 when the user submits a message. */
  onSendMessage?: (text: string, oneshotSkills?: string[]) => void;
  /** Called when the user clicks "Create new session" from the empty state. Optional provider override locks the new session provider. */
  onNewSession?: (providerOverride?: Provider, issueNumber?: number) => void;
  /** Error message from a failed session creation attempt, to surface in the empty state. */
  createSessionError?: string | null;
  /** Project path — used for the issue picker in the empty state. */
  projectPath?: string;
}

export function TimelinePanel({ onSendMessage, onNewSession, createSessionError, projectPath }: TimelinePanelProps) {
  const ipc = useIpc();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const session = useSessionStore((s) =>
    activeSessionId ? s.sessions[activeSessionId] : null
  );
  const streaming = useSessionStore((s) =>
    activeSessionId ? (s.streamingText[activeSessionId] ?? "") : ""
  );
  const toolCalls = useSessionStore(
    (s) => (activeSessionId ? s.liveToolCalls[activeSessionId] : undefined) ?? EMPTY_TOOL_CALLS
  );
  const approvals = useSessionStore(
    (s) => (activeSessionId ? s.pendingApprovals[activeSessionId] : undefined) ?? EMPTY_APPROVALS
  );
  const questions = useSessionStore(
    (s) => (activeSessionId ? s.pendingQuestions[activeSessionId] : undefined) ?? EMPTY_QUESTIONS
  );
  const compactions = useSessionStore(
    (s) => (activeSessionId ? s.sessionCompactions[activeSessionId] : undefined) ?? EMPTY_COMPACTIONS
  );
  const thinkingText = useSessionStore((s) =>
    activeSessionId ? (s.sessionThinking[activeSessionId] ?? "") : ""
  );
  const isThinking = useSessionStore((s) =>
    activeSessionId ? (s.sessionIsThinking[activeSessionId] ?? false) : false
  );
  const queuedIds = useSessionStore(
    (s) => (activeSessionId ? s.queuedMessageIds[activeSessionId] : undefined) ?? EMPTY_QUEUED_IDS
  );
  const queuePausedState = useSessionStore(
    (s) => (activeSessionId ? s.queuePaused[activeSessionId] : undefined) ?? null
  );
  const hasMoreMessages = useSessionStore((s) =>
    activeSessionId ? (s.sessionHasMoreMessages[activeSessionId] ?? false) : false
  );
  const loadOlderMessages = useLoadOlderMessages();
  const {
    removeApproval,
    removePendingQuestion,
    clearQueuePaused,
    clearQueuedMessages,
    dequeueMessage,
  } = useSessionStore(
    useShallow((s) => ({
      removeApproval: s.removeApproval,
      removePendingQuestion: s.removePendingQuestion,
      clearQueuePaused: s.clearQueuePaused,
      clearQueuedMessages: s.clearQueuedMessages,
      dequeueMessage: s.dequeueMessage,
    }))
  );
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const defaultProvider = activeProject?.config.provider ?? null;
  const { probes } = useProviderProbes(activeProjectId ?? undefined);
  const isRunning = session?.status === "running" || session?.status === "waiting_approval";
  const queuedIdsSet = useMemo(() => new Set(queuedIds), [queuedIds]);

  const messages = session?.messages ?? [];

  // Build a merged, time-sorted list of messages and compaction markers.
  // Declared here (before early returns) to satisfy Rules of Hooks.
  const timelineItems: TimelineItem[] = useMemo(() => {
    return [
      ...messages.map((m): TimelineItem => ({ kind: "message", data: m })),
      ...compactions.map((c): TimelineItem => ({ kind: "compaction", data: c })),
    ].sort((a, b) => {
      const ta = a.kind === "message" ? a.data.created_at : a.data.timestamp;
      const tb = b.kind === "message" ? b.data.created_at : b.data.timestamp;
      // Ordinal comparison — locale-aware localeCompare collation is
      // dramatically slower and orders ISO-8601 timestamps identically
      // (issue #184). This memo re-runs on every message commit.
      return ta < tb ? -1 : ta > tb ? 1 : 0;
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
    const failedMsgId = queuePausedState?.failedMessageId;
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

  // ── Virtualized scroll management ──────────────────────────────────────────
  //
  // react-virtuoso owns its own scroll container (`scrollerRef`). `followOutput`
  // handles auto-scroll when historical items are appended, but it doesn't
  // watch the Footer (streaming text / tool calls / reasoning), which grows
  // independently of `data` — so we also nudge the real scroller to the bottom
  // whenever footer-driving state changes and the user hasn't scrolled up.
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_ITEM_INDEX_START);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollerElRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [streaming, thinkingText, toolCalls, approvals, questions, queuePausedState, scrollToBottom]);

  useEffect(() => {
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setFirstItemIndex(FIRST_ITEM_INDEX_START);
    scrollToBottom("auto");
  }, [activeSessionId, scrollToBottom]);

  // ── Load older messages on scroll-up ───────────────────────────────────────
  //
  // Virtuoso's `startReached` fires when the user scrolls near index 0. Fetch
  // the next-older page (cursored on the current oldest message) and prepend
  // it, decrementing `firstItemIndex` by exactly the number of new messages
  // so Virtuoso keeps the viewport anchored instead of jumping.
  const handleStartReached = useCallback(() => {
    if (!activeSessionId || !hasMoreMessages) return;
    const oldest = messages[0];
    if (!oldest) return;
    loadOlderMessages(activeSessionId, oldest.id).then((count) => {
      if (count > 0) setFirstItemIndex((idx) => idx - count);
    });
  }, [activeSessionId, hasMoreMessages, messages, loadOlderMessages]);

  const footerContext: TimelineFooterContext = {
    showEmptyState: timelineItems.length === 0 && session?.status !== "running",
    toolCalls,
    approvals,
    questions,
    thinkingText,
    isThinking,
    showStreamingBubble: session?.status === "running",
    streaming,
    queuePausedState,
    activeSessionId,
    handleApprovalDecision,
    removePendingQuestion,
    handleQueueRecovery,
  };

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="flex flex-col h-full">
        <div className="relative flex-1 overflow-hidden">
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
        </div>
        <InputBar disabled onSend={onSendMessage} onNewSession={onNewSession} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="relative flex-1 overflow-hidden">
        <Virtuoso<TimelineItem, TimelineFooterContext>
          key={activeSessionId ?? "none"}
          style={{ height: "100%" }}
          data={timelineItems}
          context={footerContext}
          computeItemKey={(_, item) => item.data.id}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={
            timelineItems.length > 0 ? { index: timelineItems.length - 1, align: "end" } : undefined
          }
          startReached={handleStartReached}
          followOutput={(atBottom) => (atBottom ? "auto" : false)}
          atBottomStateChange={handleAtBottomStateChange}
          scrollerRef={(ref) => {
            scrollerElRef.current = ref as HTMLElement | null;
          }}
          increaseViewportBy={{ top: 400, bottom: 400 }}
          components={{ Footer: TimelineFooter }}
          itemContent={(index, item) => (
            <div className={cn("px-4", index === 0 ? "pt-4" : "pt-3")}>
              {item.kind === "message" ? (
                <MessageBubble message={item.data} isQueued={queuedIdsSet.has(item.data.id)} />
              ) : (
                <CompactionMarker event={item.data} />
              )}
            </div>
          )}
        />
        {!isAtBottom && (
          <Button
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full dark:bg-background dark:hover:bg-muted"
            onClick={() => scrollToBottom("smooth")}
            size="icon"
            type="button"
            variant="outline"
          >
            <ArrowDownIcon className="size-4" />
          </Button>
        )}
      </div>

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
