import { useState, useEffect, useCallback } from "react";
import { X, Check, AlertCircle } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProjectConfig, ApprovalRule, ApprovalPolicy, ToolCategory } from "@/types";

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = "general" | "approval";
type SaveStatus = "idle" | "saving" | "saved" | "error";

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
  options: { value: string; label: string }[];
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
        <option key={o.value} value={o.value}>
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
}: {
  config: ProjectConfig;
  onChange: (patch: Partial<ProjectConfig>) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <FieldRow>
        <FieldLabel htmlFor="ps-provider">Provider</FieldLabel>
        <SelectField
          id="ps-provider"
          value={config.provider}
          options={[
            { value: "anthropic", label: "Anthropic (Claude)" },
            { value: "copilot", label: "GitHub Copilot" },
          ]}
          onChange={(v) => onChange({ provider: v })}
        />
      </FieldRow>
      <FieldRow>
        <FieldLabel htmlFor="ps-model">Model</FieldLabel>
        <Input
          id="ps-model"
          value={config.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder="e.g. claude-sonnet-4-5"
          className="font-mono text-sm"
        />
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
          onChange={(v) =>
            onChange({ approval_mode: v as ProjectConfig["approval_mode"] })
          }
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

// ── ProjectSettingsSheet ──────────────────────────────────────────────────────

interface ProjectSettingsSheetProps {
  projectId: string;
  onClose: () => void;
}

export function ProjectSettingsSheet({ projectId, onClose }: ProjectSettingsSheetProps) {
  const [tab, setTab] = useState<Tab>("general");
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState("");

  // Load config on mount
  useEffect(() => {
    ipc.getProjectConfig(projectId)
      .then((c) => setConfig(c))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [projectId]);

  // Close on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  function patchConfig(patch: Partial<ProjectConfig>) {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    if (saveStatus === "saved" || saveStatus === "error") setSaveStatus("idle");
  }

  async function handleSave() {
    if (!config) return;
    setSaveStatus("saving");
    setSaveError("");
    try {
      await ipc.saveProjectConfig(projectId, config);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2500);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaveStatus("error");
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-label="Project settings"
        className="fixed right-0 top-[38px] z-50 flex h-[calc(100vh-38px)] w-[420px] flex-col bg-background border-l shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold">Project Settings</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b px-5">
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
              <Button size="sm" variant="outline" onClick={() => {
                setLoadError(null);
                ipc.getProjectConfig(projectId)
                  .then((c) => setConfig(c))
                  .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
              }}>
                Retry
              </Button>
            </div>
          ) : config === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-col gap-6">
              {tab === "general" && (
                <GeneralTab config={config} onChange={patchConfig} />
              )}
              {tab === "approval" && (
                <ApprovalTab config={config} onChange={patchConfig} />
              )}
              <SaveRow status={saveStatus} error={saveError} onSave={handleSave} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
