import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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

const MODELS: ModelOption[] = [
  // Anthropic
  { provider: "anthropic", model: "claude-opus-4-6", label: "Claude Opus 4.6", logoProvider: "anthropic" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", logoProvider: "anthropic" },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", logoProvider: "anthropic" },
  // OpenAI
  { provider: "openai", model: "gpt-4o", label: "GPT-4o", logoProvider: "openai" },
  { provider: "openai", model: "gpt-4o-mini", label: "GPT-4o mini", logoProvider: "openai" },
  { provider: "openai", model: "o3-mini", label: "o3-mini", logoProvider: "openai" },
  // Ollama (local)
  { provider: "ollama", model: "llama3.2", label: "Llama 3.2 (local)", logoProvider: "llama" },
  { provider: "ollama", model: "qwen2.5-coder", label: "Qwen 2.5 Coder (local)", logoProvider: "alibaba" },
  { provider: "ollama", model: "mistral", label: "Mistral (local)", logoProvider: "mistral" },
];

const GROUPS = [
  { label: "Anthropic", provider: "anthropic" },
  { label: "OpenAI", provider: "openai" },
  { label: "Ollama (local)", provider: "ollama" },
];

// ── Component ─────────────────────────────────────────────────────────────────

interface ModelPickerButtonProps {
  project: Project;
}

export function ModelPickerButton({ project }: ModelPickerButtonProps) {
  const { updateProject } = useProjectStore();
  const [open, setOpen] = useState(false);

  const current = MODELS.find(
    (m) =>
      m.provider === project.config.provider &&
      m.model === project.config.model
  );

  const handleSelect = useCallback(
    async (option: ModelOption) => {
      setOpen(false);
      const newConfig: ProjectConfig = {
        ...project.config,
        provider: option.provider,
        model: option.model,
      };
      try {
        await invoke("save_project_config", {
          projectId: project.id,
          config: newConfig,
        });
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
            <ModelSelectorLogo
              provider={current.logoProvider}
              className="opacity-70"
            />
            <span>{current.label}</span>
          </>
        ) : (
          <span>
            {project.config.provider}/{project.config.model}
          </span>
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
          {GROUPS.map((group, idx) => {
            const groupModels = MODELS.filter(
              (m) => m.provider === group.provider
            );
            return (
              <span key={group.provider}>
                {idx > 0 && <ModelSelectorSeparator />}
                <ModelSelectorGroup heading={group.label}>
                  {groupModels.map((option) => {
                    const isActive =
                      option.provider === project.config.provider &&
                      option.model === project.config.model;
                    return (
                      <ModelSelectorItem
                        key={`${option.provider}/${option.model}`}
                        value={`${option.label} ${option.provider}`}
                        onSelect={() => handleSelect(option)}
                      >
                        <ModelSelectorLogo provider={option.logoProvider} />
                        <ModelSelectorName>{option.label}</ModelSelectorName>
                        {isActive && (
                          <span className="text-xs text-primary">✓</span>
                        )}
                      </ModelSelectorItem>
                    );
                  })}
                </ModelSelectorGroup>
              </span>
            );
          })}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
