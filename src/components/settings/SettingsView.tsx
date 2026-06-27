import { useState, useEffect, useCallback } from "react";
import { useIpc } from "@/lib/ipc";
import type { SettingsMap } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { X } from "lucide-react";
import { useTheme } from "@/lib/hooks/useTheme";
import type { Theme } from "@/lib/hooks/useTheme";
import { PROVIDER_IDS, PROVIDER_LABELS } from "../../../electron/providers";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { ProjectSettingsContent } from "@/components/settings/ProjectSettingsContent";
import { useAutosave } from "@/lib/hooks/useAutosave";
import { SettingsSection } from "@/components/settings/primitives/SettingsSection";
import { SettingField, SettingStatus } from "@/components/settings/primitives/SettingField";
import { ProvidersAndKeysSection } from "@/components/settings/sections/ProvidersAndKeysSection";
import { McpServersSection } from "@/components/settings/sections/McpServersSection";

interface SettingsViewProps {
  onClose: () => void;
}

type Section = "providers" | "mcp" | "advanced" | "appearance";

// Application-tier nav rows. Project-tier rows are derived from the active
// project at render time (see PROJECT_NAV). The old "API Keys" / "Model
// Overrides" / "Providers" trio is folded into a single "Providers & Keys"
// section (one card per provider).
const APP_NAV: { id: Section; label: string }[] = [
  { id: "providers", label: "Providers & Keys" },
  { id: "mcp", label: "MCP Servers" },
  { id: "appearance", label: "Appearance" },
  { id: "advanced", label: "Advanced" },
];

// Project-tier nav rows. Step 1 keeps a single section that renders the existing
// ProjectSettingsContent (which has its own General/Approval tabs) verbatim.
const PROJECT_NAV: { id: string; label: string }[] = [
  { id: "general", label: "General" },
];

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
  const { projects, activeProjectId, settingsSection, setSettingsSection, setActiveProject } =
    useProjectStore();
  const [search, setSearch] = useState("");
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [draft, setDraft] = useState<Partial<SettingsMap>>({});

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

  // App-tier section currently selected (null when a project section is active).
  // `settingsSection.id` is typed as `string` (deep links can carry anything),
  // so validate against APP_NAV and fall back to a safe default rather than
  // casting blindly — an unknown id would otherwise render a blank panel.
  const activeSection: Section | null =
    settingsSection.scope === "app"
      ? APP_NAV.find((n) => n.id === settingsSection.id)?.id ?? "providers"
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
              <p className="px-2 pt-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Project
              </p>
              {/* Project switcher — every project is reachable here, not just the
                  one that happens to be active in the main view. Selecting one
                  makes it active so the section below edits its config. */}
              {projects.length > 0 ? (
                <div className="px-1 mb-2">
                  <label htmlFor="settings-project-switcher" className="sr-only">
                    Active project
                  </label>
                  <select
                    id="settings-project-switcher"
                    value={activeProject?.id ?? ""}
                    onChange={(e) => setActiveProject(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {!activeProject && (
                      <option value="" disabled>
                        Select a project…
                      </option>
                    )}
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <p className="px-3 py-1.5 text-xs text-muted-foreground">
                  {projectsLoading ? "Loading projects…" : "No projects."}
                </p>
              )}
              {/* Section rows only render once a project is active; the switcher
                  above owns the empty/loading state messaging. */}
              {activeProject &&
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
                ))}
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
            {/* ── Providers & Keys ── */}
            {activeSection === "providers" && (
              <ProvidersAndKeysSection settings={settings} writeSetting={writeSetting} />
            )}

            {/* ── MCP Servers ── */}
            {activeSection === "mcp" && (
              <SettingsSection
                title="MCP Servers"
                description="Manage MCP server configuration. Per-session enable/disable lives in the MCP panel."
              >
                <McpServersSection projectPath={activeProject?.path ?? ""} />
              </SettingsSection>
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
              // Key by project id: a full remount on switch ensures a pending
              // debounced autosave flushes to the project it was typed in, not
              // the newly-selected one.
              <ProjectSettingsContent key={activeProject.id} projectId={activeProject.id} />
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
