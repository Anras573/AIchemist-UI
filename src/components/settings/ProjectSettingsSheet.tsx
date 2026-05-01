import { useState, useEffect, useCallback } from "react";
import { X, Check, AlertCircle } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useProviderProbes } from "@/lib/hooks/useProviderProbes";
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
  const probeFor = (
    p: "anthropic" | "copilot" | "acp",
  ): import("@/types").ProviderProbeResult | undefined => {
    if (!probes) return undefined;
    return p === "acp" ? probes.acp : probes[p];
  };
  const opt = (
    value: "anthropic" | "copilot" | "acp",
    baseLabel: string,
  ) => {
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
            opt("acp", "ACP agent (subprocess)"),
          ]}
          onChange={(v) => onChange({ provider: v })}
        />
        {probes && (() => {
          const probe = probeFor(config.provider as "anthropic" | "copilot" | "acp");
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
          placeholder="e.g. claude-sonnet-4-5"
          className="font-mono text-sm"
        />
      </FieldRow>
      {config.provider === "acp" && <AcpAgentFields config={config} onChange={onChange} />}
    </div>
  );
}

// ── ACP agent subsection (visible when provider is "acp") ────────────────────

function AcpAgentFields({
  config,
  onChange,
}: {
  config: ProjectConfig;
  onChange: (patch: Partial<ProjectConfig>) => void;
}) {
  const acp = config.acp_agent ?? { command: "" };
  const update = (patch: Partial<NonNullable<ProjectConfig["acp_agent"]>>) =>
    onChange({ acp_agent: { ...acp, ...patch } });

  const argsString = (acp.args ?? []).join(" ");
  const envString = Object.entries(acp.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  return (
    <div className="flex flex-col gap-4 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">
        ACP launches your agent as a subprocess and talks JSON-RPC over stdio.
      </p>
      <FieldRow>
        <FieldLabel htmlFor="ps-acp-command">Command</FieldLabel>
        <Input
          id="ps-acp-command"
          value={acp.command}
          onChange={(e) => update({ command: e.target.value })}
          placeholder="e.g. /usr/local/bin/my-agent or npx"
          className="font-mono text-sm"
        />
      </FieldRow>
      <FieldRow>
        <FieldLabel htmlFor="ps-acp-args">Arguments (space-separated)</FieldLabel>
        <Input
          id="ps-acp-args"
          value={argsString}
          onChange={(e) => {
            const trimmed = e.target.value.trim();
            update({ args: trimmed ? trimmed.split(/\s+/) : [] });
          }}
          placeholder="e.g. --stdio"
          className="font-mono text-sm"
        />
      </FieldRow>
      <FieldRow>
        <FieldLabel htmlFor="ps-acp-cwd">Working directory (optional)</FieldLabel>
        <Input
          id="ps-acp-cwd"
          value={acp.cwd ?? ""}
          onChange={(e) => update({ cwd: e.target.value || undefined })}
          placeholder="Defaults to project path"
          className="font-mono text-sm"
        />
      </FieldRow>
      <FieldRow>
        <FieldLabel htmlFor="ps-acp-env">Environment (KEY=value per line)</FieldLabel>
        <textarea
          id="ps-acp-env"
          value={envString}
          onChange={(e) => {
            const env: Record<string, string> = {};
            for (const line of e.target.value.split("\n")) {
              const idx = line.indexOf("=");
              if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1);
            }
            update({ env: Object.keys(env).length > 0 ? env : undefined });
          }}
          rows={3}
          className={cn(
            "w-full rounded-md border bg-transparent px-3 py-1.5 text-sm font-mono",
            "ring-offset-background placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
          placeholder="API_TOKEN=xyz"
        />
      </FieldRow>
      <FieldRow>
        <FieldLabel htmlFor="ps-acp-auth">Auth method id (optional)</FieldLabel>
        <Input
          id="ps-acp-auth"
          value={acp.auth_method_id ?? ""}
          onChange={(e) => update({ auth_method_id: e.target.value || undefined })}
          placeholder="Set this if the agent reports authMethods"
          className="font-mono text-sm"
        />
      </FieldRow>
      <div className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span>
          Terminal capability is not supported in v1; agents that rely on shell access
          may be limited.
        </span>
      </div>
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
  const ipc = useIpc();
  const [tab, setTab] = useState<Tab>("general");
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState("");
  const { probes } = useProviderProbes(projectId);

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
    </>
  );
}
