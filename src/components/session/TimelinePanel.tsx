import { useCallback, useEffect, useState } from "react";
import { useSessionStore, LiveToolCall, PendingApproval } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { Message as MessageRecord, CompactionEvent, SkillInfo } from "@/types";
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
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import {
  SlashCommandPopover,
  buildSlashItems,
  type SlashItem,
} from "@/components/session/SlashCommandPopover";
import { QuestionCard } from "./QuestionCard";
import { useIpc } from "@/lib/ipc";

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
  onSendMessage?: (text: string, oneshotSkills?: string[]) => void;
  /** Called when the user clicks "Create new session" from the empty state. */
  onNewSession?: () => void;
}

export function TimelinePanel({ onSendMessage, onNewSession }: TimelinePanelProps) {
  const { sessions, activeSessionId, streamingText, liveToolCalls, pendingApprovals, pendingQuestions, removeApproval, removePendingQuestion, sessionCompactions, sessionThinking, sessionIsThinking } = useSessionStore();
  const { activeProjectId } = useProjectStore();
  const session = activeSessionId ? sessions[activeSessionId] : null;
  const streaming = activeSessionId ? (streamingText[activeSessionId] ?? "") : "";
  const toolCalls = activeSessionId ? (liveToolCalls[activeSessionId] ?? []) : [];
  const approvals = activeSessionId ? (pendingApprovals[activeSessionId] ?? []) : [];
  const questions = activeSessionId ? (pendingQuestions[activeSessionId] ?? []) : [];
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
        <InputBar disabled onSend={onSendMessage} onNewSession={onNewSession} />
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
          {timelineItems.length === 0 && session?.status !== "running" && (
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
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input bar */}
      <InputBar
        disabled={isRunning}
        placeholder={isRunning ? "Waiting for response…" : "Send a message…"}
        onSend={onSendMessage}
        onNewSession={onNewSession}
      />
    </div>
  );
}

// ─── Input bar ────────────────────────────────────────────────────────────────

interface InputBarProps {
  disabled?: boolean;
  placeholder?: string;
  onSend?: (text: string, oneshotSkills?: string[]) => void;
  onNewSession?: () => void;
}

/** Outer shell — provides the controlled text context for the inner bar. */
function InputBar(props: InputBarProps) {
  return (
    <PromptInputProvider>
      <InputBarInner {...props} />
    </PromptInputProvider>
  );
}

/** Inner bar — has access to usePromptInputController for slash detection. */
function InputBarInner({
  disabled,
  placeholder = "Send a message…",
  onSend,
  onNewSession,
}: InputBarProps) {
  const controller = usePromptInputController();
  const ipc = useIpc();
  const { sessions, activeSessionId, clearSessionMessages } = useSessionStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const activeProject = activeProjectId ? projects.find((p) => p.id === activeProjectId) : null;

  const [gitBranch, setGitBranch] = useState<string | null>(null);

  // Slash-command state
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashBadges, setSlashBadges] = useState<SkillInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (!activeProject?.path) { setGitBranch(null); return; }
    ipc.getGitBranch(activeProject.path).then(setGitBranch).catch(() => setGitBranch(null));
  }, [activeProject?.path]);

  // Load skills lazily when the user first types "/"
  const ensureSkillsLoaded = useCallback(() => {
    if (skills !== null || loadingSkills || !activeProject?.path) return;
    setLoadingSkills(true);
    ipc.listSkills(activeProject.path)
      .then(setSkills)
      .catch(() => setSkills([]))
      .finally(() => setLoadingSkills(false));
  }, [skills, loadingSkills, activeProject?.path]);

  // Watch textarea value for slash trigger
  const textValue = controller.textInput.value;

  useEffect(() => {
    const match = textValue.match(/(^|\s)\/(\w*)$/);
    if (match) {
      setSlashOpen(true);
      setSlashQuery(match[2]);
      setSelectedIndex(0);
      ensureSkillsLoaded();
    } else {
      setSlashOpen(false);
    }
  }, [textValue, ensureSkillsLoaded]);

  const filteredItems = buildSlashItems(slashQuery, skills ?? []);

  // Select an item from the popover
  const handleSelect = useCallback(
    (item: SlashItem) => {
      setSlashOpen(false);
      // Strip "/query" from the end of the textarea
      const stripped = controller.textInput.value
        .replace(/(^|\s)\/\w*$/, (_, prefix: string) => prefix ?? "")
        .trimEnd();
      controller.textInput.setInput(stripped);

      if (item.type === "skill") {
        setSlashBadges((prev) =>
          prev.some((b) => b.name === item.skill.name) ? prev : [...prev, item.skill]
        );
        return;
      }

      // Built-in actions
      switch (item.id) {
        case "new":
          onNewSession?.();
          break;
        case "clear":
          if (activeSessionId) clearSessionMessages(activeSessionId);
          break;
        case "agent":
          // No direct programmatic trigger for the agent picker yet; set help text
          controller.textInput.setInput("Use the agent picker button ↓ to select an agent.");
          break;
        case "help": {
          const skills_hint = skills && skills.length > 0
            ? ` · ${skills.slice(0, 3).map((s) => `/${s.name}`).join(" · ")}${skills.length > 3 ? " …" : ""}`
            : "";
          controller.textInput.setInput(
            `Slash commands: /new · /clear · /agent · /help${skills_hint}`
          );
          break;
        }
      }
    },
    [controller, onNewSession, activeSessionId, clearSessionMessages, skills]
  );

  // Keyboard navigation while popover is open (capture phase so we beat the textarea)
  useEffect(() => {
    if (!slashOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const item = filteredItems[selectedIndex];
        if (item) {
          e.preventDefault();
          e.stopPropagation();
          handleSelect(item);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [slashOpen, filteredItems, selectedIndex, handleSelect]);

  const removeBadge = useCallback((name: string) => {
    setSlashBadges((prev) => prev.filter((b) => b.name !== name));
  }, []);

  const handleSubmit = useCallback(
    ({ text }: { text: string }) => {
      const trimmed = text.trim();
      if (!trimmed && slashBadges.length === 0) return;
      if (onSend) {
        const skillNames = slashBadges.map((b) => b.name);
        onSend(trimmed, skillNames.length > 0 ? skillNames : undefined);
      }
      setSlashBadges([]);
    },
    [onSend, slashBadges]
  );

  return (
    <div className="relative flex-shrink-0">
      {slashOpen && filteredItems.length > 0 && (
        <SlashCommandPopover
          items={filteredItems}
          selectedIndex={selectedIndex}
          loadingSkills={loadingSkills}
          onSelect={handleSelect}
        />
      )}
      <PromptInput
        className="border-t rounded-none border-x-0 border-b-0"
        onSubmit={handleSubmit}
      >
        <PromptInputBody>
          {/* One-shot skill badges */}
          {slashBadges.length > 0 && (
            <div className="flex flex-wrap gap-1 px-3 pt-2">
              {slashBadges.map((skill) => (
                <span
                  key={skill.name}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 border border-primary/20 px-2 py-0.5 text-[10px] font-medium text-primary"
                >
                  {skill.name}
                  <button
                    type="button"
                    onClick={() => removeBadge(skill.name)}
                    className="ml-0.5 hover:text-primary/60 transition-colors leading-none"
                    aria-label={`Remove ${skill.name} skill`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <PromptInputTextarea placeholder={placeholder} disabled={disabled} />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
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
          </PromptInputTools>
          <PromptInputSubmit disabled={disabled} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
