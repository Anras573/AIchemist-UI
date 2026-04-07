import { useState, useCallback, useEffect } from "react";
import { useIpc } from "@/lib/ipc";
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
  ModelSelectorSeparator,
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

  // Fetch Copilot models once when the picker is first opened
  useEffect(() => {
    if (!open || copilotModels.length > 0) return;
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
  }, [open, copilotModels.length]);

  const allModels = [...ANTHROPIC_MODELS, ...copilotModels];

  const current =
    allModels.find((m) => m.provider === provider && m.model === model) ??
    (model
      ? { provider: provider ?? "", model, label: `${provider}/${model}`, logoProvider: provider ?? "" }
      : null);

  const handleSelect = useCallback(
    async (option: ModelOption) => {
      setOpen(false);
      try {
        await ipc.updateSessionModel(sessionId, option.provider, option.model);
        updateSessionModel(sessionId, option.provider, option.model);
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

          <ModelSelectorGroup heading="Anthropic">
            {ANTHROPIC_MODELS.map((option) => {
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

          {copilotModels.length > 0 && (
            <>
              <ModelSelectorSeparator />
              <ModelSelectorGroup heading="GitHub Copilot">
                {copilotModels.map((option) => {
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
            </>
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
