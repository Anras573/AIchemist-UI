import { useCallback, useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { SkillInfo, SessionUsage } from "@/types";
import type { Provider } from "@/types";
import { useIpc } from "@/lib/ipc";
import { useActiveSessionProvider } from "@/lib/hooks/useActiveSessionProvider";
import { useGitBranch } from "@/lib/hooks/useGitBranch";
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
import {
  Context,
  ContextTrigger,
  ContextContent,
  ContextContentHeader,
  ContextContentBody,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextCacheUsage,
} from "@/components/ai-elements/context";
import { getModelContextWindow } from "@/lib/models";

// ─── Session context window usage indicator ───────────────────────────────────

function SessionContextUsage({
  sessionId,
  model,
  sessionUsage,
}: {
  sessionId: string;
  model: string;
  sessionUsage: Record<string, SessionUsage>;
}) {
  const raw = sessionUsage[sessionId];
  if (!raw) return null;

  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = raw;
  const hasAnyTokens = input_tokens > 0 || output_tokens > 0;
  if (!hasAnyTokens) return null;

  // input_tokens from Anthropic already includes the full context (all previous turns).
  // Only compute a context-window % when we have a reliable full-context token count —
  // Copilot only exposes output_tokens (input_tokens === 0), which would give a misleading %.
  const usedTokens = input_tokens > 0 ? input_tokens + output_tokens : output_tokens;
  const maxTokens = input_tokens > 0 && model ? getModelContextWindow(model) ?? undefined : undefined;

  // Combine cache read + cache creation into a single "cached" total for the breakdown row.
  const cachedInputTokens = cache_read_input_tokens + cache_creation_input_tokens;

  const usage = {
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    cachedInputTokens,
    reasoningTokens: 0,
    totalTokens: usedTokens,
  };

  return (
    <Context maxTokens={maxTokens} usedTokens={usedTokens} usage={usage}>
      <ContextTrigger />
      <ContextContent>
        <ContextContentHeader />
        <ContextContentBody>
          <ContextInputUsage />
          <ContextOutputUsage />
          <ContextReasoningUsage />
          <ContextCacheUsage />
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}

// ─── Input bar ────────────────────────────────────────────────────────────────

export interface InputBarProps {
  disabled?: boolean;
  placeholder?: string;
  onSend?: (text: string, oneshotSkills?: string[]) => void;
  onNewSession?: (providerOverride?: Provider, issueNumber?: number) => void;
}

/** Outer shell — provides the controlled text context for the inner bar. */
export function InputBar(props: InputBarProps) {
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
  const { sessions, activeSessionId, clearSessionMessages, sessionUsage } = useSessionStore();
  const { projects, activeProjectId } = useProjectStore();
  // Skill discovery is provider-dependent (global/plugin scan paths differ),
  // so the slash palette must list the same skills the Skills panel shows.
  const provider = useActiveSessionProvider();
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const activeProject = activeProjectId ? projects.find((p) => p.id === activeProjectId) : null;
  const sessionPath = activeSession?.workspace_path ?? activeProject?.path ?? "";
  const { branch: gitBranch } = useGitBranch(sessionPath);

  // Slash-command state
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashBadges, setSlashBadges] = useState<SkillInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset the skill cache and one-shot badges when the effective skill scope
  // changes: the session path (sessions can have per-worktree workspace_path
  // within one project) or the provider (which determines the scan paths).
  useEffect(() => {
    setSkills(null);
    setSlashBadges([]);
  }, [sessionPath, provider]);

  // Load skills lazily when the user first types "/"
  const ensureSkillsLoaded = useCallback(() => {
    if (skills !== null || loadingSkills || !sessionPath) return;
    setLoadingSkills(true);
    ipc.listSkills(sessionPath, provider ?? undefined)
      .then(setSkills)
      .catch(() => setSkills([]))
      .finally(() => setLoadingSkills(false));
  }, [skills, loadingSkills, sessionPath, provider, ipc]);

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

  const filteredItems = useMemo(
    () => buildSlashItems(slashQuery, skills ?? []),
    [slashQuery, skills]
  );

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
            {activeSession && activeSession.messages.length > 0 && <SessionContextUsage sessionId={activeSession.id} model={activeSession.model ?? ""} sessionUsage={sessionUsage} />}
            {(activeSession?.branch ?? gitBranch) && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground/60">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M11.75 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm.75 2.25a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM4.25 13.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM5 15.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM4.25 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM5 4.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM5.75 8A3.25 3.25 0 0 0 9 11.25v.5a2.25 2.25 0 1 0 1.5 0v-.5a4.75 4.75 0 0 1-4.75-4.75v-.5a2.25 2.25 0 1 0-1.5 0v.5A3.25 3.25 0 0 0 5.75 8Z"/>
                </svg>
                {activeSession?.branch ?? gitBranch}
              </span>
            )}
          </PromptInputTools>
          <PromptInputSubmit disabled={disabled} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
