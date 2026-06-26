import { useState, useEffect, useCallback } from "react";
import { useIpc } from "@/lib/ipc";
import type { SettingsMap } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { X, Eye, EyeOff, Check, AlertCircle } from "lucide-react";
import { useTheme } from "@/lib/hooks/useTheme";
import type { Theme } from "@/lib/hooks/useTheme";
import {
  type ProviderId,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  parseDisabledProviders,
  serializeDisabledProviders,
} from "../../../electron/providers";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { ProjectSettingsContent } from "@/components/settings/ProjectSettingsContent";
import { useAutosave } from "@/lib/hooks/useAutosave";
import { SettingsSection } from "@/components/settings/primitives/SettingsSection";
import { SettingField, SettingStatus } from "@/components/settings/primitives/SettingField";

interface SettingsViewProps {
  onClose: () => void;
}

type Section = "api-keys" | "model-overrides" | "advanced" | "providers" | "appearance";
// Sections that still persist via an explicit Save button. Appearance and
// Advanced autosave instead (see useAutosave wiring below).
type ManualSection = "api-keys" | "model-overrides" | "providers";

// Application-tier nav rows. Project-tier rows are derived from the active
// project at render time (see PROJECT_NAV).
const APP_NAV: { id: Section; label: string }[] = [
  { id: "api-keys", label: "API Keys" },
  { id: "model-overrides", label: "Model Overrides" },
  { id: "providers", label: "Providers" },
  { id: "appearance", label: "Appearance" },
  { id: "advanced", label: "Advanced" },
];

// Project-tier nav rows. Step 1 keeps a single section that renders the existing
// ProjectSettingsContent (which has its own General/Approval tabs) verbatim.
const PROJECT_NAV: { id: string; label: string }[] = [
  { id: "general", label: "General" },
];

type SaveStatus = "idle" | "saving" | "saved" | "error";

// ── Password field with show/hide toggle ──────────────────────────────────────
function SecretField({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium leading-none">{label}</label>
      <div className="relative">
        <Input
          id={id}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "Not set"}
          className="pr-9 font-mono text-sm"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          tabIndex={-1}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

// ── Save button row ───────────────────────────────────────────────────────────
function SaveRow({
  status,
  onSave,
}: {
  status: SaveStatus;
  onSave: () => void;
}) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <Button onClick={onSave} disabled={status === "saving"} size="sm">
        {status === "saving" ? "Saving…" : "Save"}
      </Button>
      {status === "saved" && (
        <span className="flex items-center gap-1 text-sm text-green-600">
          <Check className="h-4 w-4" /> Saved
        </span>
      )}
      {status === "error" && (
        <span className="flex items-center gap-1 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> Save failed
        </span>
      )}
    </div>
  );
}

// ── Providers section ─────────────────────────────────────────────────────────
function ProvidersSection({
  value,
  onChange,
  status,
  onSave,
}: {
  value: string;
  onChange: (v: string) => void;
  status: SaveStatus;
  onSave: () => void;
}) {
  const disabled = parseDisabledProviders(value);
  const allDisabled = disabled.size === PROVIDER_IDS.length;

  const toggle = (p: ProviderId) => {
    const next = new Set(disabled);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    onChange(serializeDisabledProviders(next));
  };

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Hide providers you don&apos;t want to use. Disabled providers are greyed out
        in the new-session picker, the project provider dropdown, and the session
        tab&apos;s split-button menu. Existing sessions keep working — sessions are
        provider-locked at creation.
      </p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium leading-none mb-3">Enabled providers</legend>
        {PROVIDER_IDS.map((p) => {
          const enabled = !disabled.has(p);
          return (
            <label
              key={p}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                enabled ? "border-primary bg-primary/5" : "border-border hover:bg-accent/50",
              )}
            >
              <input
                type="checkbox"
                checked={enabled}
                onChange={() => toggle(p)}
                className="accent-primary"
                aria-label={PROVIDER_LABELS[p]}
              />
              <span className="text-sm font-medium">{PROVIDER_LABELS[p]}</span>
            </label>
          );
        })}
      </fieldset>
      {allDisabled && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>
            All providers are disabled — you won&apos;t be able to create new sessions.
            Enable at least one before saving.
          </span>
        </p>
      )}
      <div className="flex items-center gap-3 pt-2">
        <Button onClick={onSave} disabled={status === "saving" || allDisabled} size="sm">
          {status === "saving" ? "Saving…" : "Save"}
        </Button>
        {status === "saved" && (
          <span className="flex items-center gap-1 text-sm text-green-600">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
        {status === "error" && (
          <span className="flex items-center gap-1 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> Save failed
          </span>
        )}
      </div>
    </>
  );
}

// ── OpenAI-compatible endpoints manager ───────────────────────────────────────
type EndpointDraft = { name: string; baseURL: string; apiKey: string };

function OpenAiEndpointsSection() {
  const ipc = useIpc();
  const [endpoints, setEndpoints] = useState<Record<string, { baseURL: string; apiKey?: string }>>({});
  const [draft, setDraft] = useState<EndpointDraft | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ipc.readOpenAiEndpoints()
      .then(setEndpoints)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [ipc]);

  const startAdd = () => {
    setEditingName(null);
    setDraft({ name: "", baseURL: "", apiKey: "" });
    setError(null);
  };
  const startEdit = (name: string) => {
    const entry = endpoints[name];
    setEditingName(name);
    setDraft({ name, baseURL: entry?.baseURL ?? "", apiKey: entry?.apiKey ?? "" });
    setError(null);
  };
  const cancel = () => {
    setDraft(null);
    setEditingName(null);
    setError(null);
  };

  const save = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    try {
      // Preserve fields the form doesn't edit (headers, queryParams, …).
      const existing = editingName ? endpoints[editingName] : undefined;
      const next = await ipc.upsertOpenAiEndpoint(name, {
        ...(existing ?? {}),
        baseURL: draft.baseURL.trim(),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : { apiKey: undefined }),
      });
      setEndpoints(next);
      cancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (name: string) => {
    setError(null);
    try {
      setEndpoints(await ipc.deleteOpenAiEndpoint(name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const names = Object.keys(endpoints);

  return (
    <div className="space-y-3 pt-4 border-t border-border">
      <div>
        <h2 className="text-sm font-medium leading-none">OpenAI-compatible endpoints</h2>
        <p className="text-sm text-muted-foreground mt-1.5">
          Connect any server that speaks the OpenAI API (LM Studio, vLLM, llama.cpp,
          Together, …). Models from every endpoint appear in the model picker of
          OpenAI-compatible sessions as <code className="font-mono text-xs">endpoint/model</code>.
        </p>
      </div>

      {/* Error from loading / deleting endpoints (save errors render inside the
          form below). Without this, a failure outside an open form would either
          show no feedback or a misleading "no endpoints" empty state. */}
      {error && !draft && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {names.length === 0 && !draft && !error && (
        <p className="text-xs text-muted-foreground">No endpoints configured yet.</p>
      )}

      {names.map((name) => (
        <div key={name} className="flex items-center gap-3 rounded-lg border border-border p-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted-foreground font-mono truncate">
              {endpoints[name].baseURL}
              {endpoints[name].apiKey ? " · key set" : ""}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => startEdit(name)}>Edit</Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => remove(name)}
          >
            Delete
          </Button>
        </div>
      ))}

      {draft ? (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="space-y-1.5">
            <label htmlFor="oai-ep-name" className="text-sm font-medium leading-none">Name</label>
            <Input
              id="oai-ep-name"
              value={draft.name}
              disabled={editingName !== null}
              onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
              placeholder="lmstudio"
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="oai-ep-url" className="text-sm font-medium leading-none">Base URL</label>
            <Input
              id="oai-ep-url"
              value={draft.baseURL}
              onChange={(e) => setDraft((d) => (d ? { ...d, baseURL: e.target.value } : d))}
              placeholder="http://localhost:1234/v1"
              className="font-mono text-sm"
            />
          </div>
          <SecretField
            id="oai-ep-key"
            label="API Key (optional)"
            value={draft.apiKey}
            placeholder="Leave blank for local servers"
            onChange={(v) => setDraft((d) => (d ? { ...d, apiKey: v } : d))}
          />
          {error && (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={!draft.name.trim() || !draft.baseURL.trim()}>
              {editingName ? "Save endpoint" : "Add endpoint"}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={startAdd}>Add endpoint</Button>
      )}
    </div>
  );
}

const VALID_APPROVAL_MODES = ["none", "custom", "all"] as const;

// Mirror of the bounds in electron/settings.ts (kept as plain numbers here so
// the renderer doesn't pull the Node-only settings module into its bundle).
const DEFAULT_MAX_TOOL_ROUNDS = 8;
const MIN_MAX_TOOL_ROUNDS = 1;
const MAX_MAX_TOOL_ROUNDS = 100;

function normalizeProvider(v: string | undefined): string {
  const normalized = v?.trim().toLowerCase() ?? "";
  return (PROVIDER_IDS as readonly string[]).includes(normalized) ? normalized : "anthropic";
}
// Mirror parseMaxToolRounds() in electron/settings.ts: trim → "" means
// "use the default"; otherwise parse + clamp so the persisted value matches
// what the app actually uses (an <input type="number"> can still hold
// out-of-range / non-numeric text via paste).
function normalizeMaxToolRounds(v: string | undefined): string {
  const trimmed = (v ?? "").trim();
  if (trimmed === "") return "";
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return "";
  return String(Math.min(MAX_MAX_TOOL_ROUNDS, Math.max(MIN_MAX_TOOL_ROUNDS, n)));
}
function normalizeApprovalMode(v: string | undefined): string {
  const normalized = v?.trim().toLowerCase() ?? "";
  return VALID_APPROVAL_MODES.includes(normalized as typeof VALID_APPROVAL_MODES[number]) ? normalized : "custom";
}

// ── Main view ─────────────────────────────────────────────────────────────────
export function SettingsView({ onClose }: SettingsViewProps) {
  const ipc = useIpc();
  const { projects, activeProjectId, settingsSection, setSettingsSection } = useProjectStore();
  const [search, setSearch] = useState("");
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [draft, setDraft] = useState<Partial<SettingsMap>>({});
  // Manual Save sections (still using the SaveRow). Appearance and Advanced were
  // converted to autosave (useAutosave) and no longer appear here.
  const [saveStatus, setSaveStatus] = useState<Record<ManualSection, SaveStatus>>({
    "api-keys": "idle",
    "model-overrides": "idle",
    providers: "idle",
  });

  const { theme, setTheme } = useTheme();

  useEffect(() => {
    ipc.settingsRead().then((s) => {
      setSettings(s);
      setDraft(s);
    }).catch(console.error);
  }, []);

  const set = useCallback((key: keyof SettingsMap, val: string) => {
    setDraft((d) => ({ ...d, [key]: val }));
  }, []);

  // ── Autosave wiring for Appearance + Advanced ──────────────────────────────
  // Persist a single setting key, mirroring it into local state so the field
  // reflects the saved (optionally normalized) value and undo can restore it.
  const writeSetting = useCallback(
    async (key: keyof SettingsMap, value: string) => {
      await ipc.settingsWrite({ [key]: value } as Partial<SettingsMap>);
      setSettings((s) => (s ? { ...s, [key]: value } : s));
      setDraft((d) => ({ ...d, [key]: value }));
    },
    [ipc],
  );

  // `initialValue` seeds the undo baseline, so it must track the *persisted*
  // value (`settings`) — not `draft`, which mirrors unsaved local edits and
  // would otherwise let a failed/uncommitted change poison the undo baseline.
  const themeSave = useAutosave<Theme>((v) => setTheme(v), { initialValue: theme });
  const providerSave = useAutosave<string>(
    (v) => writeSetting("AICHEMIST_DEFAULT_PROVIDER", v),
    { initialValue: normalizeProvider(settings?.AICHEMIST_DEFAULT_PROVIDER) },
  );
  const approvalSave = useAutosave<string>(
    (v) => writeSetting("AICHEMIST_DEFAULT_APPROVAL_MODE", v),
    { initialValue: normalizeApprovalMode(settings?.AICHEMIST_DEFAULT_APPROVAL_MODE) },
  );
  // Normalization happens at the commit boundary (see the field's onChange) so
  // the value useAutosave tracks as the undo baseline matches what is persisted.
  const toolRoundsSave = useAutosave<string>(
    (v) => writeSetting("AICHEMIST_MAX_TOOL_ROUNDS", v),
    { initialValue: normalizeMaxToolRounds(settings?.AICHEMIST_MAX_TOOL_ROUNDS) },
  );

  const saveSection = useCallback(
    async (section: ManualSection) => {
      if (!settings) return;
      setSaveStatus((s) => ({ ...s, [section]: "saving" }));

      const sectionKeys: Record<ManualSection, (keyof SettingsMap)[]> = {
        "api-keys": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN"],
        "model-overrides": [
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          "ANTHROPIC_DEFAULT_OPUS_MODEL",
        ],
        providers: ["AICHEMIST_DISABLED_PROVIDERS"],
      };

      const updates: Partial<SettingsMap> = {};
      for (const k of sectionKeys[section]) {
        updates[k] = (draft[k] ?? "") as string & SettingsMap[typeof k];
      }

      try {
        await ipc.settingsWrite(updates);
        setSettings((s) => (s ? { ...s, ...updates } : s));
        // Reflect any normalization (e.g. clamped 9999 → 100) back into the field.
        setDraft((d) => ({ ...d, ...updates }));
        setSaveStatus((s) => ({ ...s, [section]: "saved" }));
        setTimeout(() => setSaveStatus((s) => ({ ...s, [section]: "idle" })), 2500);
      } catch {
        setSaveStatus((s) => ({ ...s, [section]: "error" }));
      }
    },
    [draft, settings]
  );

  // App-tier section currently selected (null when a project section is active).
  // `settingsSection.id` is typed as `string` (deep links can carry anything),
  // so validate against APP_NAV and fall back to a safe default rather than
  // casting blindly — an unknown id would otherwise render a blank panel.
  const activeSection: Section | null =
    settingsSection.scope === "app"
      ? APP_NAV.find((n) => n.id === settingsSection.id)?.id ?? "api-keys"
      : null;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  // A persisted activeProjectId can resolve before the async-loaded projects
  // list arrives; treat that window as "loading" rather than "no project".
  const projectsLoading = activeProjectId !== null && activeProject === null && projects.length === 0;

  // Case-insensitive nav filter over section labels.
  const q = search.trim().toLowerCase();
  const matches = (label: string) => q === "" || label.toLowerCase().includes(q);
  const appNav = APP_NAV.filter((n) => matches(n.label));
  const projectNav = PROJECT_NAV.filter((n) => matches(n.label));

  const getTitle = (): string => {
    if (settingsSection.scope === "app") {
      // Stable fallback so the header never goes blank on an unknown id.
      return APP_NAV.find((n) => n.id === settingsSection.id)?.label ?? "Settings";
    }
    const sectionLabel = PROJECT_NAV.find((n) => n.id === settingsSection.id)?.label ?? "Settings";
    return activeProject ? `${activeProject.name} — ${sectionLabel}` : sectionLabel;
  };

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        Loading settings…
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden bg-background">
      {/* Left nav */}
      <nav className="w-52 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
        {/* Search */}
        <div className="flex-none pt-12 px-2 pb-2">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="h-8 text-sm"
          />
        </div>

        <div className="flex-1 overflow-y-auto pb-2">
          {/* Application sections */}
          {appNav.length > 0 && (
            <div className="px-2 pt-1 pb-3">
              <p className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Application
              </p>
              {appNav.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setSettingsSection({ scope: "app", id })}
                  className={cn(
                    "w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors",
                    settingsSection.scope === "app" && settingsSection.id === id
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Project sections */}
          {projectNav.length > 0 && (
            <div className="px-2 pt-1 pb-2 border-t border-border">
              <p className="px-2 pt-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 truncate">
                {activeProject ? activeProject.name : "Project"}
              </p>
              {activeProject ? (
                projectNav.map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => setSettingsSection({ scope: "project", id })}
                    className={cn(
                      "w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors",
                      settingsSection.scope === "project" && settingsSection.id === id
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                    )}
                  >
                    {label}
                  </button>
                ))
              ) : (
                <p className="px-3 py-1.5 text-xs text-muted-foreground">
                  {projectsLoading ? "Loading projects…" : "No active project."}
                </p>
              )}
            </div>
          )}
        </div>
      </nav>

      {/* Right panel */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between h-12 px-6 border-b border-border flex-shrink-0">
          <h1 className="text-base font-semibold">{getTitle()}</h1>
          <WithTooltip label="Close settings (Esc)">
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close settings">
              <X className="h-4 w-4" />
            </Button>
          </WithTooltip>
        </div>

        {/* Section content */}
        {settingsSection.scope === "app" && (
          <div className="flex-1 overflow-y-auto px-8 py-6 max-w-xl space-y-6">
            {/* ── API Keys ── */}
            {activeSection === "api-keys" && (
              <>
                <div className="space-y-4">
                  <SecretField
                    id="anthropic-key"
                    label="Anthropic API Key"
                    value={draft.ANTHROPIC_API_KEY ?? ""}
                    placeholder="sk-ant-…"
                    onChange={(v) => set("ANTHROPIC_API_KEY", v)}
                  />
                  <SecretField
                    id="anthropic-auth-token"
                    label="Anthropic Auth Token (fallback)"
                    value={draft.ANTHROPIC_AUTH_TOKEN ?? ""}
                    placeholder="Only needed when ANTHROPIC_API_KEY is absent"
                    onChange={(v) => set("ANTHROPIC_AUTH_TOKEN", v)}
                  />
                  <SecretField
                    id="github-token"
                    label="GitHub Token (Copilot)"
                    value={draft.GITHUB_TOKEN ?? ""}
                    placeholder="ghp_…"
                    onChange={(v) => set("GITHUB_TOKEN", v)}
                  />
                </div>
                <SaveRow status={saveStatus["api-keys"]} onSave={() => saveSection("api-keys")} />
              </>
            )}

            {/* ── Model Overrides ── */}
            {activeSection === "model-overrides" && (
              <>
                <p className="text-sm text-muted-foreground">
                  Override the Anthropic model used for each tier. Leave blank to use the
                  SDK default.
                </p>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label htmlFor="base-url" className="text-sm font-medium leading-none">Anthropic Base URL</label>
                    <Input
                      id="base-url"
                      value={draft.ANTHROPIC_BASE_URL ?? ""}
                      onChange={(e) => set("ANTHROPIC_BASE_URL", e.target.value)}
                      placeholder="https://api.anthropic.com (default)"
                      className="font-mono text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="sonnet-model" className="text-sm font-medium leading-none">Sonnet Model Override</label>
                    <Input
                      id="sonnet-model"
                      value={draft.ANTHROPIC_DEFAULT_SONNET_MODEL ?? ""}
                      onChange={(e) => set("ANTHROPIC_DEFAULT_SONNET_MODEL", e.target.value)}
                      placeholder="claude-sonnet-4-6"
                      className="font-mono text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="haiku-model" className="text-sm font-medium leading-none">Haiku Model Override</label>
                    <Input
                      id="haiku-model"
                      value={draft.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? ""}
                      onChange={(e) => set("ANTHROPIC_DEFAULT_HAIKU_MODEL", e.target.value)}
                      placeholder="claude-haiku-4-5-20251001"
                      className="font-mono text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="opus-model" className="text-sm font-medium leading-none">Opus Model Override</label>
                    <Input
                      id="opus-model"
                      value={draft.ANTHROPIC_DEFAULT_OPUS_MODEL ?? ""}
                      onChange={(e) => set("ANTHROPIC_DEFAULT_OPUS_MODEL", e.target.value)}
                      placeholder="claude-opus-4-8"
                      className="font-mono text-sm"
                    />
                  </div>
                </div>
                <SaveRow
                  status={saveStatus["model-overrides"]}
                  onSave={() => saveSection("model-overrides")}
                />
              </>
            )}

            {/* ── Advanced (autosave) ── */}
            {activeSection === "advanced" && (
              <SettingsSection
                title="Advanced"
                description="Global defaults applied to new projects. Per-project settings always take precedence."
              >
                <SettingField
                  variant="select"
                  id="default-provider"
                  label="Default Provider"
                  value={normalizeProvider(draft.AICHEMIST_DEFAULT_PROVIDER)}
                  options={PROVIDER_IDS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))}
                  onChange={(v) => {
                    set("AICHEMIST_DEFAULT_PROVIDER", v);
                    providerSave.commit(v, { immediate: true });
                  }}
                  status={providerSave.status}
                  canUndo={providerSave.canUndo}
                  onUndo={providerSave.undo}
                  error={providerSave.error}
                />
                <SettingField
                  variant="select"
                  id="default-approval"
                  label="Default Approval Mode"
                  value={normalizeApprovalMode(draft.AICHEMIST_DEFAULT_APPROVAL_MODE)}
                  options={[
                    { value: "none", label: "None — never ask for approval" },
                    { value: "custom", label: "Custom — approve risky tools only" },
                    { value: "all", label: "All — approve every tool call" },
                  ]}
                  onChange={(v) => {
                    set("AICHEMIST_DEFAULT_APPROVAL_MODE", v);
                    approvalSave.commit(v, { immediate: true });
                  }}
                  status={approvalSave.status}
                  canUndo={approvalSave.canUndo}
                  onUndo={approvalSave.undo}
                  error={approvalSave.error}
                />
                <SettingField
                  variant="number"
                  id="max-tool-rounds"
                  label="Max tool rounds"
                  min={MIN_MAX_TOOL_ROUNDS}
                  max={MAX_MAX_TOOL_ROUNDS}
                  step={1}
                  value={draft.AICHEMIST_MAX_TOOL_ROUNDS ?? ""}
                  placeholder={String(DEFAULT_MAX_TOOL_ROUNDS)}
                  onChange={(v) => {
                    // Show the raw input while typing; persist (and track as the
                    // undo baseline) the clamped value the app actually uses.
                    set("AICHEMIST_MAX_TOOL_ROUNDS", v);
                    toolRoundsSave.commit(normalizeMaxToolRounds(v));
                  }}
                  status={toolRoundsSave.status}
                  canUndo={toolRoundsSave.canUndo}
                  onUndo={toolRoundsSave.undo}
                  error={toolRoundsSave.error}
                  helper={
                    <>
                      Caps the in-process tool loop for the Ollama and OpenAI-compatible
                      providers so long tasks aren&apos;t cut off silently. Leave blank for
                      the default ({DEFAULT_MAX_TOOL_ROUNDS}). Range {MIN_MAX_TOOL_ROUNDS}–{MAX_MAX_TOOL_ROUNDS}.
                      Claude and Copilot ignore this (they&apos;re bounded by the context window).
                    </>
                  }
                />
              </SettingsSection>
            )}

            {/* ── Providers ── */}
            {activeSection === "providers" && (
              <>
                <ProvidersSection
                  value={draft.AICHEMIST_DISABLED_PROVIDERS ?? ""}
                  onChange={(v) => set("AICHEMIST_DISABLED_PROVIDERS", v)}
                  status={saveStatus["providers"]}
                  onSave={() => saveSection("providers")}
                />
                <OpenAiEndpointsSection />
              </>
            )}

            {/* ── Appearance (autosave) ── */}
            {activeSection === "appearance" && (
              <SettingsSection
                title="Theme"
                description="Choose how AIchemist looks. System follows your OS setting."
                action={
                  <SettingStatus
                    status={themeSave.status}
                    canUndo={themeSave.canUndo}
                    onUndo={themeSave.undo}
                  />
                }
              >
                <fieldset className="space-y-2">
                  <legend className="sr-only">Theme</legend>
                  {(
                    [
                      { value: "system", label: "System", description: "Matches your OS preference" },
                      { value: "light",  label: "Light",  description: "Always use light mode" },
                      { value: "dark",   label: "Dark",   description: "Always use dark mode" },
                    ] as { value: Theme; label: string; description: string }[]
                  ).map(({ value, label, description }) => (
                    <label
                      key={value}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border p-3.5 cursor-pointer transition-colors",
                        theme === value
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-accent/50"
                      )}
                    >
                      <input
                        type="radio"
                        name="theme"
                        value={value}
                        checked={theme === value}
                        onChange={() => themeSave.commit(value, { immediate: true })}
                        className="no-drag-region accent-primary"
                      />
                      <div>
                        <p className="text-sm font-medium">{label}</p>
                        <p className="text-xs text-muted-foreground">{description}</p>
                      </div>
                    </label>
                  ))}
                </fieldset>
              </SettingsSection>
            )}
          </div>
        )}

        {/* Project settings content */}
        {settingsSection.scope === "project" && (
          <div className="flex-1 overflow-hidden">
            {activeProject ? (
              <ProjectSettingsContent projectId={activeProject.id} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm p-8">
                {projectsLoading ? "Loading project…" : "No active project selected."}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
