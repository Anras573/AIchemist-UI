import { useState, useEffect, useCallback } from "react";
import { ipc } from "@/lib/ipc";
import type { SettingsMap } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Eye, EyeOff, Check, AlertCircle } from "lucide-react";

interface SettingsViewProps {
  onClose: () => void;
}

type Section = "api-keys" | "model-overrides" | "defaults";

const NAV: { id: Section; label: string }[] = [
  { id: "api-keys", label: "API Keys" },
  { id: "model-overrides", label: "Model Overrides" },
  { id: "defaults", label: "Defaults" },
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

// ── Main view ─────────────────────────────────────────────────────────────────
export function SettingsView({ onClose }: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<Section>("api-keys");
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [draft, setDraft] = useState<Partial<SettingsMap>>({});
  const [saveStatus, setSaveStatus] = useState<Record<Section, SaveStatus>>({
    "api-keys": "idle",
    "model-overrides": "idle",
    defaults: "idle",
  });

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
        "api-keys": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GITHUB_TOKEN"],
        "model-overrides": [
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          "ANTHROPIC_DEFAULT_OPUS_MODEL",
        ],
        defaults: ["AICHEMIST_DEFAULT_PROVIDER", "AICHEMIST_DEFAULT_APPROVAL_MODE"],
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
          <Button variant="ghost" size="icon" onClick={onClose} title="Close settings (Esc)">
            <X className="h-4 w-4" />
          </Button>
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
                  id="openai-key"
                  label="OpenAI API Key"
                  value={draft.OPENAI_API_KEY ?? ""}
                  placeholder="sk-…"
                  onChange={(v) => set("OPENAI_API_KEY", v)}
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
                    <option value="openai">OpenAI</option>
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
        </div>
      </div>
    </div>
  );
}
