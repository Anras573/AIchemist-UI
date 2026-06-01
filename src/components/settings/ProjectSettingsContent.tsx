import { useState, useEffect, useRef } from "react";
import { AlertCircle, Check } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useProviderProbes } from "@/lib/hooks/useProviderProbes";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProjectConfig, ApprovalRule, ApprovalPolicy, ToolCategory } from "@/types";

type Tab = "general" | "approval";
type SaveStatus = "idle" | "saving" | "saved" | "error";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "approval", label: "Approval" },
];

const TOOL_CATEGORIES: { category: ToolCategory; label: string }[] = [
  { category: "filesystem", label: "Filesystem" },
  { category: "shell", label: "Shell" },
  { category: "web", label: "Web" },
];

const APPROVAL_POLICIES: { value: ApprovalPolicy; label: string }[] = [
  { value: "always", label: "Always" },
  { value: "never", label: "Never" },
  { value: "risky_only", label: "Risky only" },
];

// ── Field components ──────────────────────────────────────────────────────────

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium leading-none">
      {children}
    </label>
  );
}

function FieldRow({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}

function SelectField({
  id,
  value,
  options,
  onChange,
}: {
  id?: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} title={o.title}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── Save row ──────────────────────────────────────────────────────────────────

function SaveRow({ status, error, onSave }: { status: SaveStatus; error: string; onSave: () => void }) {
  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={status === "saving"} size="sm">
          {status === "saving" ? "Saving…" : "Save"}
        </Button>
        {status === "saved" && (
          <span className="flex items-center gap-1 text-sm text-green-600">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
      </div>
      {status === "error" && (
        <div className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error || "Failed to save. Please try again."}
        </div>
      )}
    </div>
  );
}

// ── General tab ───────────────────────────────────────────────────────────────

function GeneralTab({
  config,
  onChange,
  probes,
}: {
  config: ProjectConfig;
  onChange: (patch: Partial<ProjectConfig>) => void;
  probes: import("@/types").ProviderProbes | null;
}) {
  const ipc = useIpc();
  const probeFor = (
    p: "anthropic" | "copilot" | "ollama",
  ): import("@/types").ProviderProbeResult | undefined => {
    if (!probes) return undefined;
    return probes[p];
  };
  const opt = (value: "anthropic" | "copilot" | "ollama", baseLabel: string) => {
    const probe = probeFor(value);
    const unavailable = probe ? !probe.ok : false;
    return {
      value,
      label: unavailable ? `${baseLabel} — unavailable` : baseLabel,
      disabled: unavailable && config.provider !== value,
      title: unavailable ? probe?.reason : undefined,
    };
  };
  return (
    <div className="flex flex-col gap-5">
      <FieldRow>
        <FieldLabel htmlFor="ps-provider">Provider</FieldLabel>
        <SelectField
          id="ps-provider"
          value={config.provider}
          options={[
            opt("anthropic", "Anthropic (Claude)"),
            opt("copilot", "GitHub Copilot"),
            opt("ollama", "Ollama"),
          ]}
          onChange={(v) => {
            const provider = v as import("@/types").Provider;
            if (v !== config.provider) {
              onChange({ provider, model: v === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "" });
              return;
            }
            onChange({ provider });
          }}
        />
        {probes && (() => {
          const probe = probeFor(config.provider as "anthropic" | "copilot" | "ollama");
          if (probe && !probe.ok) {
            return (
              <p className="text-xs text-destructive flex items-start gap-1">
                <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                <span>{probe.reason}</span>
              </p>
            );
          }
          return null;
        })()}
      </FieldRow>
      <FieldRow>
        <FieldLabel htmlFor="ps-model">Model</FieldLabel>
        <Input
          id="ps-model"
          value={config.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder="e.g. claude-sonnet-4-6"
          className="font-mono text-sm"
        />
      </FieldRow>
      <FieldRow>
        <label htmlFor="ps-create-worktree" className="flex items-start gap-2 text-sm font-medium leading-none">
          <input
            id="ps-create-worktree"
            type="checkbox"
            checked={config.create_worktree_per_session}
            onChange={(e) => onChange({ create_worktree_per_session: e.target.checked })}
            className="mt-0.5 h-4 w-4 rounded border-border"
          />
          <span className="space-y-1">
            <span className="block">Create branch per session</span>
            <span className="block text-xs font-normal text-muted-foreground">
              Create a git worktree for each session when the project is git-backed.
            </span>
          </span>
        </label>
      </FieldRow>
      <FieldRow>
        <FieldLabel htmlFor="ps-worktree-root">Managed worktree root (optional)</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="ps-worktree-root"
            value={config.worktree_root_path ?? ""}
            onChange={(e) => onChange({ worktree_root_path: e.target.value || undefined })}
            placeholder="Defaults to the project parent directory"
            className="font-mono text-sm"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              const selected = await ipc.openFolderDialog();
              if (selected) onChange({ worktree_root_path: selected });
            }}
          >
            Browse
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Invalid paths fall back to the project parent directory when a session is created.
        </p>
      </FieldRow>
    </div>
  );
}

// ── Approval tab ──────────────────────────────────────────────────────────────

function ApprovalTab({
  config,
  onChange,
}: {
  config: ProjectConfig;
  onChange: (patch: Partial<ProjectConfig>) => void;
}) {
  function getPolicyForCategory(category: ToolCategory): ApprovalPolicy {
    return config.approval_rules.find((r) => r.tool_category === category)?.policy ?? "risky_only";
  }

  function setPolicy(category: ToolCategory, policy: ApprovalPolicy) {
    const rules: ApprovalRule[] = TOOL_CATEGORIES.map((tc) => ({
      tool_category: tc.category,
      policy: tc.category === category ? policy : getPolicyForCategory(tc.category),
    }));
    onChange({ approval_rules: rules });
  }

  return (
    <div className="flex flex-col gap-5">
      <FieldRow>
        <FieldLabel htmlFor="ps-approval-mode">Approval mode</FieldLabel>
        <SelectField
          id="ps-approval-mode"
          value={config.approval_mode}
          options={[
            { value: "all", label: "All — require approval for every tool call" },
            { value: "none", label: "None — never ask for approval" },
            { value: "custom", label: "Custom — per-category rules" },
          ]}
          onChange={(v) => onChange({ approval_mode: v as ProjectConfig["approval_mode"] })}
        />
      </FieldRow>

      {config.approval_mode === "custom" && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Configure when each tool category requires user approval before running.
          </p>
          {TOOL_CATEGORIES.map(({ category, label }) => (
            <div key={category} className="flex items-center gap-3">
              <span className="text-sm w-24 shrink-0">{label}</span>
              <div className="flex-1">
                <SelectField
                  value={getPolicyForCategory(category)}
                  options={APPROVAL_POLICIES}
                  onChange={(v) => setPolicy(category, v as ApprovalPolicy)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main exported component ───────────────────────────────────────────────────

interface ProjectSettingsContentProps {
  projectId: string;
}

export function ProjectSettingsContent({ projectId }: ProjectSettingsContentProps) {
  const ipc = useIpc();
  const [tab, setTab] = useState<Tab>("general");
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState("");
  const { probes } = useProviderProbes(projectId);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setTab("general");
    setConfig(null);
    setLoadError(null);
    setSaveStatus("idle");
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    let active = true;
    ipc.getProjectConfig(projectId)
      .then((c) => { if (active) setConfig(c); })
      .catch((e) => { if (active) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [projectId]);

  function patchConfig(patch: Partial<ProjectConfig>) {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    if (saveStatus === "saved" || saveStatus === "error") setSaveStatus("idle");
  }

  async function handleSave() {
    if (!config) return;
    setSaveStatus("saving");
    setSaveError("");
    try {
      const normalizedConfig =
        config.provider === "anthropic" && !config.model.trim()
          ? { ...config, model: DEFAULT_ANTHROPIC_MODEL }
          : config;
      if (config.provider === "anthropic" && !config.model.trim()) {
        setConfig(normalizedConfig);
      }
      await ipc.saveProjectConfig(projectId, normalizedConfig);
      setSaveStatus("saved");
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2500);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaveStatus("error");
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-border px-5 flex-shrink-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "px-1 py-2.5 mr-5 text-sm border-b-2 -mb-px transition-colors",
              tab === t.id
                ? "border-foreground text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {loadError ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {loadError}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLoadError(null);
                ipc.getProjectConfig(projectId)
                  .then((c) => setConfig(c))
                  .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
              }}
            >
              Retry
            </Button>
          </div>
        ) : config === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex flex-col gap-6 max-w-xl">
            {tab === "general" && (
              <GeneralTab config={config} onChange={patchConfig} probes={probes} />
            )}
            {tab === "approval" && (
              <ApprovalTab config={config} onChange={patchConfig} />
            )}
            <SaveRow status={saveStatus} error={saveError} onSave={handleSave} />
          </div>
        )}
      </div>
    </div>
  );
}
