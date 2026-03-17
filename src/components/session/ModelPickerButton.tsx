import { useState, useCallback, useEffect } from "react";
import { ipc } from "@/lib/ipc";
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
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { Project, ProjectConfig } from "@/types";

// ── Static model catalogue ────────────────────────────────────────────────────

interface ModelOption {
  provider: string;
  model: string;
  label: string;
  logoProvider: string;
}

const ANTHROPIC_MODELS: ModelOption[] = [
  { provider: "anthropic", model: "claude-opus-4-6",           label: "Claude Opus 4.6",   logoProvider: "anthropic" },
  { provider: "anthropic", model: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6", logoProvider: "anthropic" },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5",  logoProvider: "anthropic" },
];

// ── Component ─────────────────────────────────────────────────────────────────

interface ModelPickerButtonProps {
  project: Project;
}

export function ModelPickerButton({ project }: ModelPickerButtonProps) {
  const { updateProject } = useProjectStore();
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
    allModels.find(
      (m) => m.provider === project.config.provider && m.model === project.config.model
    ) ??
    // Fallback label for unknown model IDs
    (project.config.model
      ? { provider: project.config.provider, model: project.config.model, label: `${project.config.provider}/${project.config.model}`, logoProvider: project.config.provider }
      : null);

  const handleSelect = useCallback(
    async (option: ModelOption) => {
      setOpen(false);
      const newConfig: ProjectConfig = {
        ...project.config,
        provider: option.provider,
        model: option.model,
      };
      try {
        await ipc.saveProjectConfig(project.id, newConfig);
        updateProject({ ...project, config: newConfig });
      } catch (err) {
        console.error("save_project_config failed:", err);
      }
    },
    [project, updateProject]
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
              const isActive =
                option.provider === project.config.provider &&
                option.model === project.config.model;
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
                  const isActive =
                    option.provider === project.config.provider &&
                    option.model === project.config.model;
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
