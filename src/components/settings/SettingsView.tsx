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

interface SettingsViewProps {
  onClose: () => void;
}

type Section = "api-keys" | "model-overrides" | "defaults" | "providers" | "appearance";

const NAV: { id: Section; label: string }[] = [
  { id: "api-keys", label: "API Keys" },
  { id: "model-overrides", label: "Model Overrides" },
  { id: "defaults", label: "Defaults" },
  { id: "providers", label: "Providers" },
  { id: "appearance", label: "Appearance" },
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
type ProviderId = "anthropic" | "copilot" | "acp";
const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic (Claude)",
  copilot: "GitHub Copilot",
  acp: "ACP",
};

function parseDisabled(raw: string): Set<ProviderId> {
  const out = new Set<ProviderId>();
  for (const part of raw.split(",")) {
    const v = part.trim().toLowerCase();
    if (v === "anthropic" || v === "copilot" || v === "acp") out.add(v);
  }
  return out;
}

function serializeDisabled(set: Set<ProviderId>): string {
  return (["anthropic", "copilot", "acp"] as const).filter((p) => set.has(p)).join(",");
}

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
  const disabled = parseDisabled(value);
  const allDisabled = disabled.size === 3;

  const toggle = (p: ProviderId) => {
    const next = new Set(disabled);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    onChange(serializeDisabled(next));
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
        {(["anthropic", "copilot", "acp"] as const).map((p) => {
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

// ── Main view ─────────────────────────────────────────────────────────────────
export function SettingsView({ onClose }: SettingsViewProps) {
  const ipc = useIpc();
  const [activeSection, setActiveSection] = useState<Section>("api-keys");
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [draft, setDraft] = useState<Partial<SettingsMap>>({});
  const [saveStatus, setSaveStatus] = useState<Record<Section, SaveStatus>>({
    "api-keys": "idle",
    "model-overrides": "idle",
    defaults: "idle",
    providers: "idle",
    appearance: "idle",
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

  const saveSection = useCallback(
    async (section: Section) => {
      if (!settings) return;
      setSaveStatus((s) => ({ ...s, [section]: "saving" }));

      const sectionKeys: Record<Section, (keyof SettingsMap)[]> = {
        "api-keys": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN"],
        "model-overrides": [
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          "ANTHROPIC_DEFAULT_OPUS_MODEL",
        ],
        defaults: ["AICHEMIST_DEFAULT_PROVIDER", "AICHEMIST_DEFAULT_APPROVAL_MODE"],
        providers: ["AICHEMIST_DISABLED_PROVIDERS"],
        appearance: [], // theme is auto-saved via useTheme, no batch save needed
      };

      const updates: Partial<SettingsMap> = {};
      for (const k of sectionKeys[section]) {
        updates[k] = (draft[k] ?? "") as string & SettingsMap[typeof k];
      }

      try {
        await ipc.settingsWrite(updates);
        setSettings((s) => (s ? { ...s, ...updates } : s));
        setSaveStatus((s) => ({ ...s, [section]: "saved" }));
        setTimeout(() => setSaveStatus((s) => ({ ...s, [section]: "idle" })), 2500);
      } catch {
        setSaveStatus((s) => ({ ...s, [section]: "error" }));
      }
    },
    [draft, settings]
  );

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
      <nav className="w-52 flex-shrink-0 border-r border-border flex flex-col pt-14 px-2 gap-1">
        <p className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Settings
        </p>
        {NAV.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActiveSection(id)}
            className={cn(
              "w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors",
              activeSection === id
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* Right panel */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {/* Toolbar */}
        <div className="flex items-center justify-between h-12 px-6 border-b border-border flex-shrink-0">
          <h1 className="text-base font-semibold">
            {NAV.find((n) => n.id === activeSection)?.label}
          </h1>
          <WithTooltip label="Close settings (Esc)">
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close settings">
              <X className="h-4 w-4" />
            </Button>
          </WithTooltip>
        </div>

        <div className="flex-1 px-8 py-6 max-w-xl space-y-6">
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
                    placeholder="claude-sonnet-4-5"
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="haiku-model" className="text-sm font-medium leading-none">Haiku Model Override</label>
                  <Input
                    id="haiku-model"
                    value={draft.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? ""}
                    onChange={(e) => set("ANTHROPIC_DEFAULT_HAIKU_MODEL", e.target.value)}
                    placeholder="claude-haiku-4-5"
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="opus-model" className="text-sm font-medium leading-none">Opus Model Override</label>
                  <Input
                    id="opus-model"
                    value={draft.ANTHROPIC_DEFAULT_OPUS_MODEL ?? ""}
                    onChange={(e) => set("ANTHROPIC_DEFAULT_OPUS_MODEL", e.target.value)}
                    placeholder="claude-opus-4-5"
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

          {/* ── Defaults ── */}
          {activeSection === "defaults" && (
            <>
              <p className="text-sm text-muted-foreground">
                Global defaults applied to new projects. Per-project settings always take
                precedence.
              </p>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="default-provider" className="text-sm font-medium leading-none">Default Provider</label>
                  <select
                    id="default-provider"
                    value={draft.AICHEMIST_DEFAULT_PROVIDER ?? "anthropic"}
                    onChange={(e) => set("AICHEMIST_DEFAULT_PROVIDER", e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="copilot">GitHub Copilot</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="default-approval" className="text-sm font-medium leading-none">Default Approval Mode</label>
                  <select
                    id="default-approval"
                    value={draft.AICHEMIST_DEFAULT_APPROVAL_MODE ?? "custom"}
                    onChange={(e) => set("AICHEMIST_DEFAULT_APPROVAL_MODE", e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="none">None — never ask for approval</option>
                    <option value="custom">Custom — approve risky tools only</option>
                    <option value="all">All — approve every tool call</option>
                  </select>
                </div>
              </div>
              <SaveRow
                status={saveStatus["defaults"]}
                onSave={() => saveSection("defaults")}
              />
            </>
          )}
          {/* ── Providers ── */}
          {activeSection === "providers" && (
            <ProvidersSection
              value={draft.AICHEMIST_DISABLED_PROVIDERS ?? ""}
              onChange={(v) => set("AICHEMIST_DISABLED_PROVIDERS", v)}
              status={saveStatus["providers"]}
              onSave={() => saveSection("providers")}
            />
          )}
          {/* ── Appearance ── */}
          {activeSection === "appearance" && (
            <>
              <p className="text-sm text-muted-foreground">
                Choose how AIchemist looks. System follows your OS setting.
              </p>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium leading-none mb-3">Theme</legend>
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
                      onChange={() => setTheme(value)}
                      className="no-drag-region accent-primary"
                    />
                    <div>
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-xs text-muted-foreground">{description}</p>
                    </div>
                  </label>
                ))}
              </fieldset>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
