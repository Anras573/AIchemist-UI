import { useState, useEffect, useRef, useCallback } from "react";
import { AlertCircle } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import type { SettingsMap } from "@/lib/ipc";
import { useProviderProbes } from "@/lib/hooks/useProviderProbes";
import { useAutosave } from "@/lib/hooks/useAutosave";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingStatus } from "@/components/settings/primitives/SettingField";
import type { ProjectConfig, ApprovalRule, ApprovalPolicy, ToolCategory } from "@/types";
import { PROVIDER_IDS, PROVIDER_LABELS } from "../../../electron/providers";

type Tab = "general" | "approval";
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

const APPROVAL_MODE_LABELS: Record<ProjectConfig["approval_mode"], string> = {
  all: "All",
  none: "None",
  custom: "Custom",
};

// App-wide defaults surfaced as inheritance ghost text on the General tab.
interface AppDefaults {
  provider: string;
  approvalMode: string;
}

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

// Subtle inheritance hint shown beneath a General field: states whether the
// project is riding the app default or overriding it.
function InheritanceHint({ inherits, defaultLabel }: { inherits: boolean; defaultLabel: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {inherits ? (
        <>Matches the app default ({defaultLabel}).</>
      ) : (
        <>App default: {defaultLabel} — this project overrides it.</>
      )}
    </p>
  );
}

function SelectField({
  id,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  id?: string;
  ariaLabel?: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
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

// ── General tab ───────────────────────────────────────────────────────────────

function GeneralTab({
  config,
  onChange,
  probes,
  appDefaults,
}: {
  config: ProjectConfig;
  onChange: (patch: Partial<ProjectConfig>, opts?: { immediate?: boolean }) => void;
  probes: import("@/types").ProviderProbes | null;
  appDefaults: AppDefaults | null;
}) {
  const ipc = useIpc();
  const probeFor = (
    p: import("@/types").Provider,
  ): import("@/types").ProviderProbeResult | undefined => {
    if (!probes) return undefined;
    return probes[p];
  };
  const opt = (value: import("@/types").Provider, baseLabel: string) => {
    const probe = probeFor(value);
    const unavailable = probe ? !probe.ok : false;
    return {
      value,
      label: unavailable ? `${baseLabel} — unavailable` : baseLabel,
      disabled: unavailable && config.provider !== value,
      title: unavailable ? probe?.reason : undefined,
    };
  };
  // Ghost text for the model field: the effective default the provider falls
  // back to when the field is left blank (Anthropic normalizes to a known
  // model; other providers resolve at session creation).
  const modelPlaceholder =
    config.provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "Provider default (resolved per session)";
  const defaultProviderLabel =
    appDefaults && (PROVIDER_IDS as readonly string[]).includes(appDefaults.provider)
      ? PROVIDER_LABELS[appDefaults.provider as import("@/types").Provider]
      : null;
  return (
    <div className="flex flex-col gap-5">
      <FieldRow>
        <FieldLabel htmlFor="ps-provider">Provider</FieldLabel>
        <SelectField
          id="ps-provider"
          value={config.provider}
          options={PROVIDER_IDS.map((p) => opt(p, PROVIDER_LABELS[p]))}
          onChange={(v) => {
            const provider = v as import("@/types").Provider;
            if (v !== config.provider) {
              onChange(
                { provider, model: v === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "" },
                { immediate: true },
              );
              return;
            }
            onChange({ provider }, { immediate: true });
          }}
        />
        {probes && (() => {
          const probe = probeFor(config.provider);
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
        {defaultProviderLabel && (
          <InheritanceHint
            inherits={config.provider === appDefaults?.provider}
            defaultLabel={defaultProviderLabel}
          />
        )}
      </FieldRow>
      <FieldRow>
        <FieldLabel htmlFor="ps-model">Model</FieldLabel>
        <Input
          id="ps-model"
          value={config.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder={modelPlaceholder}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Leave blank to use the provider default ({modelPlaceholder}).
        </p>
      </FieldRow>
      <FieldRow>
        <label htmlFor="ps-create-worktree" className="flex items-start gap-2 text-sm font-medium leading-none">
          <input
            id="ps-create-worktree"
            type="checkbox"
            checked={config.create_worktree_per_session}
            onChange={(e) => onChange({ create_worktree_per_session: e.target.checked }, { immediate: true })}
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
              if (selected) onChange({ worktree_root_path: selected }, { immediate: true });
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
  onChange: (patch: Partial<ProjectConfig>, opts?: { immediate?: boolean }) => void;
}) {
  function getPolicyForCategory(category: ToolCategory): ApprovalPolicy {
    return config.approval_rules.find((r) => r.tool_category === category)?.policy ?? "risky_only";
  }

  function setPolicy(category: ToolCategory, policy: ApprovalPolicy) {
    // Update the edited category in place and preserve every other existing
    // rule — including categories not shown in this UI (e.g. "custom"), which a
    // blanket TOOL_CATEGORIES rebuild would silently drop.
    const existing = config.approval_rules;
    const rules: ApprovalRule[] = existing.some((r) => r.tool_category === category)
      ? existing.map((r) => (r.tool_category === category ? { ...r, policy } : r))
      : [...existing, { tool_category: category, policy }];
    onChange({ approval_rules: rules }, { immediate: true });
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
          onChange={(v) => onChange({ approval_mode: v as ProjectConfig["approval_mode"] }, { immediate: true })}
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
                  ariaLabel={`${label} approval policy`}
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

// Apply the Anthropic default-model normalization: an Anthropic project with a
// blank model resolves to a known default so the turn never runs model-less.
function normalizeConfig(config: ProjectConfig): ProjectConfig {
  return config.provider === "anthropic" && !config.model.trim()
    ? { ...config, model: DEFAULT_ANTHROPIC_MODEL }
    : config;
}

export function ProjectSettingsContent({ projectId }: ProjectSettingsContentProps) {
  const ipc = useIpc();
  const [tab, setTab] = useState<Tab>("general");
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  // The last value actually persisted (set on load + successful save). Distinct
  // from `config`, which is the live draft and may hold an unsaved edit. This is
  // the only thing fed to useAutosave's `initialValue` so the undo baseline can
  // never re-sync to a value that was never written (e.g. after a failed save).
  const [persistedConfig, setPersistedConfig] = useState<ProjectConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [appDefaults, setAppDefaults] = useState<AppDefaults | null>(null);
  const { probes } = useProviderProbes(projectId);
  const loadGenRef = useRef(0);
  const mountedRef = useRef(true);
  // Monotonic token per save: a slower older save must not sync its (stale)
  // value back into local state after a newer edit has superseded it.
  const saveSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenRef.current++;
    };
  }, []);

  // Autosave the whole ProjectConfig: every field commits the full config (text
  // fields debounced, selects/toggles immediate). The save fn mirrors the
  // persisted value back into local state, which also lets undo — a re-persist
  // of the prior config — visually revert the form. The committed value is
  // already normalized (see patchConfig), so what useAutosave tracks for its
  // undo baseline matches exactly what gets written.
  const persistConfig = useCallback(
    async (next: ProjectConfig) => {
      const seq = ++saveSeqRef.current;
      await ipc.saveProjectConfig(projectId, next);
      // Only the latest save, and only while still mounted, may sync local
      // state — guards against an older in-flight save clobbering a newer edit
      // or touching an unmounted tree (e.g. the unmount flush on project switch).
      if (!mountedRef.current || seq !== saveSeqRef.current) return;
      setConfig(next);
      setPersistedConfig(next);
    },
    [ipc, projectId],
  );
  const save = useAutosave<ProjectConfig>(persistConfig, {
    initialValue: persistedConfig ?? undefined,
  });

  function loadConfig() {
    const gen = ++loadGenRef.current;
    setConfig(null);
    setPersistedConfig(null);
    setLoadError(null);
    ipc.getProjectConfig(projectId)
      .then((c) => { if (loadGenRef.current === gen) { setConfig(c); setPersistedConfig(c); } })
      .catch((e) => { if (loadGenRef.current === gen) setLoadError(e instanceof Error ? e.message : String(e)); });
  }

  useEffect(() => {
    setTab("general");
    loadConfig();
  }, [projectId]);

  // App-wide defaults power the General tab's inheritance ghost text. Failure to
  // read them is non-fatal — the hints simply don't render.
  useEffect(() => {
    let cancelled = false;
    ipc.settingsRead()
      .then((s: SettingsMap) => {
        if (cancelled) return;
        setAppDefaults({
          provider: (s.AICHEMIST_DEFAULT_PROVIDER || "anthropic").trim().toLowerCase(),
          approvalMode: (s.AICHEMIST_DEFAULT_APPROVAL_MODE || "custom").trim().toLowerCase(),
        });
      })
      .catch(() => { /* ghost text is best-effort */ });
    return () => { cancelled = true; };
  }, [ipc]);

  function patchConfig(patch: Partial<ProjectConfig>, opts?: { immediate?: boolean }) {
    if (!config) return;
    const next = { ...config, ...patch };
    // Reflect the raw edit immediately (a blank model stays blank while typing);
    // commit the normalized value so autosave persists — and tracks for undo —
    // exactly what lands in the DB.
    setConfig(next);
    save.commit(normalizeConfig(next), opts);
  }

  const defaultApprovalLabel =
    appDefaults && (["all", "none", "custom"] as const).includes(appDefaults.approvalMode as ProjectConfig["approval_mode"])
      ? APPROVAL_MODE_LABELS[appDefaults.approvalMode as ProjectConfig["approval_mode"]]
      : null;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar + inline autosave status */}
      <div className="flex items-center justify-between border-b border-border px-5 flex-shrink-0">
        <div className="flex">
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
        <SettingStatus status={save.status} canUndo={save.canUndo} onUndo={save.undo} />
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
              onClick={() => loadConfig()}
            >
              Retry
            </Button>
          </div>
        ) : config === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex flex-col gap-6 max-w-xl">
            {tab === "general" && (
              <GeneralTab config={config} onChange={patchConfig} probes={probes} appDefaults={appDefaults} />
            )}
            {tab === "approval" && (
              <>
                <ApprovalTab config={config} onChange={patchConfig} />
                {defaultApprovalLabel && (
                  <p className="text-xs text-muted-foreground">
                    {config.approval_mode === appDefaults?.approvalMode
                      ? `Matches the app default approval mode (${defaultApprovalLabel}).`
                      : `App default approval mode: ${defaultApprovalLabel} — this project overrides it.`}
                  </p>
                )}
              </>
            )}
            {save.error && (
              <div className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {save.error.message || "Failed to save. Please try again."}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
