import { useState, useCallback, useEffect } from "react";
import { useIpc } from "@/lib/ipc";
import type { Provider } from "@/types";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { ANTHROPIC_MODELS, type ModelOption } from "@/lib/models";

// ── Component ─────────────────────────────────────────────────────────────────

interface ModelPickerButtonProps {
  sessionId: string;
  provider: string | null;
  model: string | null;
}

export function ModelPickerButton({ sessionId, provider, model }: ModelPickerButtonProps) {
  const ipc = useIpc();
  const { updateSessionModel } = useSessionStore();
  const [open, setOpen] = useState(false);
  const [copilotModels, setCopilotModels] = useState<ModelOption[]>([]);
  const [ollamaModels, setOllamaModels] = useState<ModelOption[]>([]);
  const [openAiCompatModels, setOpenAiCompatModels] = useState<ModelOption[]>([]);

  // Reset cached model lists when the session changes so a fresh fetch occurs
  // for the new session's provider.
  useEffect(() => {
    setCopilotModels([]);
    setOllamaModels([]);
    setOpenAiCompatModels([]);
  }, [sessionId]);

  // Provider is locked at session creation time. Only load Copilot models if
  // this session is a Copilot session — saves an IPC round trip for Claude
  // sessions and avoids showing the other SDK's models at all.
  useEffect(() => {
    if (!open || provider !== "copilot" || copilotModels.length > 0) return;
    ipc.getCopilotModels()
      .then((models) => {
        setCopilotModels(
          models.map((m) => ({
            provider: "copilot",
            model: m.id,
            label: m.name,
            logoProvider: "github-copilot",
          }))
        );
      })
      .catch(() => {/* Copilot not configured — silently hide the group */});
  }, [open, provider, copilotModels.length]);

  useEffect(() => {
    if (!open || provider !== "ollama" || ollamaModels.length > 0) return;
    ipc.getOllamaModels()
      .then((models) => {
        setOllamaModels(
          models.map((m) => ({
            provider: "ollama",
            model: m.id,
            label: m.name,
            logoProvider: "ollama",
          }))
        );
      })
      .catch(() => {/* Ollama not configured — silently hide the group */});
  }, [open, provider, ollamaModels.length]);

  useEffect(() => {
    if (!open || provider !== "openai-compatible" || openAiCompatModels.length > 0) return;
    ipc.getOpenAiCompatModels()
      .then((models) => {
        setOpenAiCompatModels(
          // Composite ids (`<endpoint>/<modelId>`) — label keeps the endpoint
          // visible so models from different endpoints stay distinguishable.
          models.map((m) => ({
            provider: "openai-compatible",
            model: m.id,
            label: m.id,
            logoProvider: "openai",
          }))
        );
      })
      .catch(() => {/* No endpoints configured — silently hide the group */});
  }, [open, provider, openAiCompatModels.length]);

  // Only show the group matching the session's locked provider.
  const visibleAnthropic = provider === "anthropic" ? ANTHROPIC_MODELS : [];
  const visibleCopilot = provider === "copilot" ? copilotModels : [];
  const visibleOllama = provider === "ollama" ? ollamaModels : [];
  const visibleOpenAiCompat = provider === "openai-compatible" ? openAiCompatModels : [];
  const allModels = [...visibleAnthropic, ...visibleCopilot, ...visibleOllama, ...visibleOpenAiCompat];

  const current =
    allModels.find((m) => m.provider === provider && m.model === model) ??
    (model
      ? { provider: provider ?? "", model, label: `${provider}/${model}`, logoProvider: provider ?? "" }
      : null);

  const handleSelect = useCallback(
    async (option: ModelOption) => {
      setOpen(false);
      try {
        await ipc.updateSessionModel(sessionId, option.provider as Provider, option.model);
        updateSessionModel(sessionId, option.provider as Provider, option.model);
      } catch (err) {
        console.error("update_session_model failed:", err);
      }
    },
    [sessionId, updateSessionModel]
  );

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer border-none bg-transparent">
        {current ? (
          <>
            <ModelSelectorLogo provider={current.logoProvider} className="opacity-70" />
            <span>{current.label}</span>
          </>
        ) : (
          <span>Select model</span>
        )}
        <svg
          className="size-3 opacity-50"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 4.5l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </ModelSelectorTrigger>

      <ModelSelectorContent className="w-72">
        <ModelSelectorInput placeholder="Search models…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>

          {visibleAnthropic.length > 0 && (
            <ModelSelectorGroup heading="Anthropic">
              {visibleAnthropic.map((option) => {
                const isActive = option.provider === provider && option.model === model;
                return (
                  <ModelSelectorItem
                    key={option.model}
                    value={`${option.label} ${option.provider}`}
                    onSelect={() => handleSelect(option)}
                  >
                    <ModelSelectorLogo provider={option.logoProvider} />
                    <ModelSelectorName>{option.label}</ModelSelectorName>
                    {isActive && <span className="text-xs text-primary">✓</span>}
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
          )}

          {visibleCopilot.length > 0 && (
            <ModelSelectorGroup heading="GitHub Copilot">
              {visibleCopilot.map((option) => {
                const isActive = option.provider === provider && option.model === model;
                return (
                  <ModelSelectorItem
                    key={option.model}
                    value={`${option.label} ${option.provider}`}
                    onSelect={() => handleSelect(option)}
                  >
                    <ModelSelectorLogo provider={option.logoProvider} />
                    <ModelSelectorName>{option.label}</ModelSelectorName>
                    {isActive && <span className="text-xs text-primary">✓</span>}
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
          )}

          {visibleOllama.length > 0 && (
            <ModelSelectorGroup heading="Ollama">
              {visibleOllama.map((option) => {
                const isActive = option.provider === provider && option.model === model;
                return (
                  <ModelSelectorItem
                    key={option.model}
                    value={`${option.label} ${option.provider}`}
                    onSelect={() => handleSelect(option)}
                  >
                    <ModelSelectorLogo provider={option.logoProvider} />
                    <ModelSelectorName>{option.label}</ModelSelectorName>
                    {isActive && <span className="text-xs text-primary">✓</span>}
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
          )}

          {visibleOpenAiCompat.length > 0 && (
            <ModelSelectorGroup heading="OpenAI-compatible">
              {visibleOpenAiCompat.map((option) => {
                const isActive = option.provider === provider && option.model === model;
                return (
                  <ModelSelectorItem
                    key={option.model}
                    value={`${option.label} ${option.provider}`}
                    onSelect={() => handleSelect(option)}
                  >
                    <ModelSelectorLogo provider={option.logoProvider} />
                    <ModelSelectorName>{option.label}</ModelSelectorName>
                    {isActive && <span className="text-xs text-primary">✓</span>}
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
