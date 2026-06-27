import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useIpc } from "@/lib/ipc";
import type { SettingsMap } from "@/lib/ipc";
import type { Provider, ProviderProbeResult } from "@/types";
import { useProviderProbes } from "@/lib/hooks/useProviderProbes";
import { useAutosave } from "@/lib/hooks/useAutosave";
import { SettingField } from "@/components/settings/primitives/SettingField";
import { ProbeBadge } from "@/components/settings/primitives/ProbeBadge";
import {
  PROVIDER_IDS,
  PROVIDER_LABELS,
  type ProviderId,
  parseDisabledProviders,
  serializeDisabledProviders,
} from "../../../../electron/providers";

// Keys that affect connectivity — after these autosave we force a fresh probe
// (debounced, so not per-keystroke) so the card's badge reflects reality.
type SettingKey = keyof SettingsMap;

interface ProvidersAndKeysSectionProps {
  /** The currently-persisted settings (source of truth + undo baseline). */
  settings: SettingsMap;
  /** Persist one setting key; resolves once `settings` reflects the new value. */
  writeSetting: (key: SettingKey, value: string) => Promise<void>;
}

// ── A single autosaved settings field (text / secret) ─────────────────────────
// Holds its own display draft so typing is responsive, re-syncing from the
// persisted value on load and on undo (which re-persists the previous value).
function AutosaveSettingField({
  settingKey,
  variant,
  label,
  persistedValue,
  placeholder,
  helper,
  write,
}: {
  settingKey: SettingKey;
  variant: "text" | "secret";
  label: string;
  persistedValue: string;
  placeholder?: string;
  helper?: ReactNode;
  write: (key: SettingKey, value: string) => Promise<void>;
}) {
  // Coerce — settings may not yet carry every key (async load / partial mocks).
  const persisted = persistedValue ?? "";
  const [draft, setDraft] = useState(persisted);
  const editing = useRef(false);

  useEffect(() => {
    // Re-sync from the persisted value whenever it changes and we're not
    // mid-edit — covers the async settings load and undo's re-persist.
    if (!editing.current) setDraft(persisted);
  }, [persisted]);

  const save = useAutosave<string>(
    async (v) => {
      // Once we're persisting, later persistedValue updates (incl. undo) own
      // the field again.
      editing.current = false;
      await write(settingKey, v);
    },
    { initialValue: persisted },
  );

  return (
    <SettingField
      variant={variant}
      id={settingKey}
      label={label}
      value={draft}
      placeholder={placeholder}
      helper={helper}
      mono
      onChange={(v) => {
        editing.current = true;
        setDraft(v);
        save.commit(v);
      }}
      status={save.status}
      canUndo={save.canUndo}
      onUndo={save.undo}
      error={save.error}
    />
  );
}

// ── Provider card shell ───────────────────────────────────────────────────────
function ProviderCard({
  provider,
  probe,
  checking,
  enabled,
  onToggleEnabled,
  canDisable,
  children,
}: {
  provider: Provider;
  probe: ProviderProbeResult | undefined;
  checking: boolean;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  canDisable: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold truncate">{PROVIDER_LABELS[provider as ProviderId]}</h3>
          {/* Pass the probe through even when disabled — the backend reports a
              disabled provider as `{ ok: false, reason: "Disabled in settings" }`,
              which the badge summarizes as "Disabled" (gating on `enabled` would
              instead show the "Checking…" loading state forever). */}
          <ProbeBadge result={probe} checking={checking} />
        </div>
        <label className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={`Enable ${PROVIDER_LABELS[provider as ProviderId]}`}
            disabled={enabled && !canDisable}
            onClick={() => onToggleEnabled(!enabled)}
            className={cn(
              "relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
              enabled ? "bg-primary" : "bg-input",
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform",
                enabled ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </label>
      </div>
      {enabled && children}
    </div>
  );
}

// ── Collapsible "Advanced" disclosure (Anthropic base URL + tier overrides) ───
function AdvancedDisclosure({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Advanced Anthropic settings"
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        Advanced
      </button>
      {open && <div className="space-y-4">{children}</div>}
    </div>
  );
}

// ── OpenAI-compatible endpoints manager (ported verbatim from SettingsView) ───
type EndpointDraft = { name: string; baseURL: string; apiKey: string };

function EndpointSecretField({
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
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
          aria-label={show ? "Hide value" : "Show value"}
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

function OpenAiEndpointsManager({ onEndpointsChanged }: { onEndpointsChanged: () => void }) {
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
      onEndpointsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (name: string) => {
    setError(null);
    try {
      setEndpoints(await ipc.deleteOpenAiEndpoint(name));
      onEndpointsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const names = Object.keys(endpoints);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Connect any server that speaks the OpenAI API (LM Studio, vLLM, llama.cpp,
        Together, …). Models from every endpoint appear in the model picker as{" "}
        <code className="font-mono text-xs">endpoint/model</code>.
      </p>

      {/* Error from loading / deleting endpoints (save errors render inside the
          form below). */}
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
          <EndpointSecretField
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

// ── The section ───────────────────────────────────────────────────────────────
export function ProvidersAndKeysSection({ settings, writeSetting }: ProvidersAndKeysSectionProps) {
  const { probes, checking, refresh } = useProviderProbes();

  // Persist a connection-affecting field, then force-refresh probes so the
  // card badge reflects the new state. Debounced upstream (autosave), so this
  // never fires per keystroke; the force bypasses the 30 s probe cache.
  const writeAndProbe = async (key: SettingKey, value: string) => {
    await writeSetting(key, value);
    await refresh(true);
  };

  const disabled = parseDisabledProviders(settings.AICHEMIST_DISABLED_PROVIDERS);
  const enabledCount = PROVIDER_IDS.length - disabled.size;
  const allDisabled = enabledCount === 0;

  const toggleProvider = async (p: ProviderId, enable: boolean) => {
    const next = new Set(disabled);
    if (enable) next.delete(p);
    else next.add(p);
    // Guard: never let the user disable the last remaining provider.
    if (next.size === PROVIDER_IDS.length) return;
    try {
      await writeAndProbe("AICHEMIST_DISABLED_PROVIDERS", serializeDisabledProviders(next));
    } catch (err) {
      // A persist/probe failure shouldn't surface as an unhandled rejection; log
      // it. The toggle reverts visually since `disabled` is derived from the
      // unchanged settings (the optimistic state was never applied).
      console.error("[ProvidersAndKeysSection] failed to toggle provider", p, err);
    }
  };

  const cardProps = (p: ProviderId) => ({
    provider: p as Provider,
    probe: probes?.[p as Provider],
    // Before the first probe resolves (`probes === null`) there's no entry yet —
    // treat that as "checking" so the badge shows the loading state rather than
    // flickering through "Unavailable" on first paint.
    checking: checking || probes === null,
    enabled: !disabled.has(p),
    onToggleEnabled: (enable: boolean) => void toggleProvider(p, enable),
    // A provider can only be disabled while it isn't the last one standing.
    canDisable: enabledCount > 1,
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          One card per provider — keys, connection settings, and an enabled toggle.
          Secrets are masked and stored in <code className="font-mono text-xs">~/.aichemist/.env</code>.
          Disabled providers are greyed out in the new-session pickers (existing
          sessions keep working — sessions are provider-locked at creation).
        </p>
        {allDisabled && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>All providers are disabled — you won&apos;t be able to create new sessions.</span>
          </p>
        )}
      </div>

      {/* Anthropic */}
      <ProviderCard {...cardProps("anthropic")}>
        <AutosaveSettingField
          settingKey="ANTHROPIC_API_KEY"
          variant="secret"
          label="Anthropic API Key"
          persistedValue={settings.ANTHROPIC_API_KEY}
          placeholder="sk-ant-…"
          write={writeAndProbe}
        />
        <AdvancedDisclosure>
          <AutosaveSettingField
            settingKey="ANTHROPIC_AUTH_TOKEN"
            variant="secret"
            label="Auth Token (fallback)"
            persistedValue={settings.ANTHROPIC_AUTH_TOKEN}
            placeholder="Only used when ANTHROPIC_API_KEY is absent"
            write={writeAndProbe}
          />
          <AutosaveSettingField
            settingKey="ANTHROPIC_BASE_URL"
            variant="text"
            label="Base URL"
            persistedValue={settings.ANTHROPIC_BASE_URL}
            placeholder="https://api.anthropic.com (default)"
            write={writeAndProbe}
          />
          <AutosaveSettingField
            settingKey="ANTHROPIC_DEFAULT_SONNET_MODEL"
            variant="text"
            label="Sonnet Model Override"
            persistedValue={settings.ANTHROPIC_DEFAULT_SONNET_MODEL}
            placeholder="claude-sonnet-4-6"
            write={writeSetting}
          />
          <AutosaveSettingField
            settingKey="ANTHROPIC_DEFAULT_HAIKU_MODEL"
            variant="text"
            label="Haiku Model Override"
            persistedValue={settings.ANTHROPIC_DEFAULT_HAIKU_MODEL}
            placeholder="claude-haiku-4-5-20251001"
            write={writeSetting}
          />
          <AutosaveSettingField
            settingKey="ANTHROPIC_DEFAULT_OPUS_MODEL"
            variant="text"
            label="Opus Model Override"
            persistedValue={settings.ANTHROPIC_DEFAULT_OPUS_MODEL}
            placeholder="claude-opus-4-8"
            write={writeSetting}
          />
        </AdvancedDisclosure>
      </ProviderCard>

      {/* Copilot */}
      <ProviderCard {...cardProps("copilot")}>
        <AutosaveSettingField
          settingKey="GITHUB_TOKEN"
          variant="secret"
          label="GitHub Token"
          persistedValue={settings.GITHUB_TOKEN}
          placeholder="ghp_…"
          helper="Used to authenticate the GitHub Copilot provider."
          write={writeAndProbe}
        />
      </ProviderCard>

      {/* Ollama */}
      <ProviderCard {...cardProps("ollama")}>
        <p className="text-sm text-muted-foreground">
          Ollama runs locally and needs no key. The badge above reflects
          reachability and whether at least one model is installed.
        </p>
      </ProviderCard>

      {/* OpenAI-compatible */}
      <ProviderCard {...cardProps("openai-compatible")}>
        <OpenAiEndpointsManager onEndpointsChanged={() => void refresh(true)} />
      </ProviderCard>

      {/* Codex */}
      <ProviderCard {...cardProps("codex")}>
        <AutosaveSettingField
          settingKey="OPENAI_API_KEY"
          variant="secret"
          label="OpenAI API Key"
          persistedValue={settings.OPENAI_API_KEY}
          placeholder="sk-…"
          helper="Used by the OpenAI Codex provider."
          write={writeAndProbe}
        />
      </ProviderCard>
    </div>
  );
}
