import { useEffect, useMemo, useState } from "react";
import { useIpc } from "@/lib/ipc";
import { previewCron } from "@/lib/cron";
import { PROVIDERS, PROVIDER_SHORT_LABELS } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Check, Clock, Loader2 } from "lucide-react";
import type {
  AgentInfo,
  Project,
  Provider,
  SkillInfo,
  Workflow,
  WorkflowAutonomy,
  WorkflowSessionStrategy,
} from "@/types";

interface WorkflowEditorProps {
  /** The workflow being edited, or null to create a new one. */
  workflow: Workflow | null;
  /** Project pre-selected for a new workflow (the active project). */
  defaultProjectId: string | null;
  projects: Project[];
  onSaved: (workflow: Workflow) => void;
  onCancel: () => void;
}

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export function WorkflowEditor({
  workflow,
  defaultProjectId,
  projects,
  onSaved,
  onCancel,
}: WorkflowEditorProps) {
  const ipc = useIpc();
  const isEdit = workflow !== null;

  const [name, setName] = useState(workflow?.name ?? "");
  const [prompt, setPrompt] = useState(workflow?.prompt ?? "");
  const [projectId, setProjectId] = useState(
    workflow?.project_id ?? defaultProjectId ?? projects[0]?.id ?? ""
  );
  const [provider, setProvider] = useState<string>(workflow?.provider ?? "");
  const [model, setModel] = useState(workflow?.model ?? "");
  const [agent, setAgent] = useState(workflow?.agent ?? "");
  const [skills, setSkills] = useState<string[]>(workflow?.skills ?? []);
  const [cron, setCron] = useState(workflow?.cron ?? "");
  const [watchPath, setWatchPath] = useState(workflow?.watch_path ?? "");
  const [sessionStrategy, setSessionStrategy] = useState<WorkflowSessionStrategy>(
    workflow?.session_strategy ?? "fresh"
  );
  const [autonomy, setAutonomy] = useState<WorkflowAutonomy>(
    workflow?.autonomy ?? "interactive"
  );
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Discovery-backed agent + skills pickers, sourced per the editor's resolved
  // provider + project (matching the session UI). The agent/skills lists are
  // loaded from IPC so a user picks real, discovered values rather than typing
  // free-text that may not resolve at run time.
  const selectedProject = projects.find((p) => p.id === projectId) ?? null;
  const projectPath = selectedProject?.path ?? "";
  const effectiveProvider = provider || selectedProject?.config.provider || "";

  const [availableAgents, setAvailableAgents] = useState<AgentInfo[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(false);

  useEffect(() => {
    if (!projectPath || !effectiveProvider) {
      setAvailableAgents([]);
      setAvailableSkills([]);
      // Clear any leftover loading state — an in-flight fetch's .finally() was
      // skipped by its `cancelled` guard, so reset here to avoid a stuck spinner.
      setLoadingMeta(false);
      return;
    }
    let cancelled = false;
    setLoadingMeta(true);
    const agentFetch =
      effectiveProvider === "copilot"
        ? ipc.getCopilotAgents(projectPath)
        : ipc.getClaudeAgents(projectPath);
    Promise.allSettled([agentFetch, ipc.listSkills(projectPath, effectiveProvider)])
      .then(([agentsRes, skillsRes]) => {
        if (cancelled) return;
        setAvailableAgents(agentsRes.status === "fulfilled" ? agentsRes.value : []);
        setAvailableSkills(skillsRes.status === "fulfilled" ? skillsRes.value : []);
      })
      .finally(() => {
        if (!cancelled) setLoadingMeta(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, effectiveProvider, ipc]);

  // Include a previously-saved agent that isn't in the discovered list so
  // switching provider/project never silently drops it.
  const agentOptions = useMemo(() => {
    const names = availableAgents.map((a) => a.name);
    return agent && !names.includes(agent) ? [agent, ...names] : names;
  }, [availableAgents, agent]);

  // Render discovered skills plus any selected skills no longer discovered, so
  // an edit never silently loses a previously-saved skill.
  const skillItems = useMemo(() => {
    const discovered = availableSkills.map((s) => ({
      name: s.name,
      description: s.description,
      discovered: true,
    }));
    const discoveredNames = new Set(discovered.map((s) => s.name));
    const orphans = skills
      .filter((s) => !discoveredNames.has(s))
      .map((s) => ({ name: s, description: "Not discovered for this provider/project", discovered: false }));
    return [...discovered, ...orphans];
  }, [availableSkills, skills]);

  const cronPreview = useMemo(() => previewCron(cron), [cron]);

  const canSave =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    projectId.length > 0 &&
    cronPreview.valid &&
    !saving;

  const toggleSkill = (skillName: string) => {
    setSkills((prev) =>
      prev.includes(skillName) ? prev.filter((s) => s !== skillName) : [...prev, skillName]
    );
  };

  const handleBrowseWatchPath = async () => {
    try {
      const dir = await ipc.openFolderDialog();
      if (dir) setWatchPath(dir);
    } catch (err) {
      console.error("openFolderDialog failed:", err);
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await ipc.workflowUpsert({
        id: workflow?.id,
        projectId,
        name: name.trim(),
        prompt: prompt.trim(),
        provider: (provider || null) as Provider | null,
        model: model.trim() || null,
        agent: agent.trim() || null,
        skills: skills.length > 0 ? skills : null,
        cron: cron.trim() || null,
        watchPath: watchPath.trim() || null,
        enabled,
        sessionStrategy,
        autonomy,
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save workflow");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <h2 className="text-base font-semibold">
        {isEdit ? "Edit workflow" : "New workflow"}
      </h2>

      {/* Name */}
      <Field label="Name" htmlFor="wf-name">
        <Input
          id="wf-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nightly test triage"
        />
      </Field>

      {/* Prompt */}
      <Field label="Prompt" htmlFor="wf-prompt" hint="The task sent as the turn prompt.">
        <Textarea
          id="wf-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Run the test suite and fix anything that broke."
          rows={4}
        />
      </Field>

      {/* Project */}
      <Field label="Project" htmlFor="wf-project">
        <select
          id="wf-project"
          className={SELECT_CLASS}
          value={projectId}
          disabled={isEdit}
          onChange={(e) => setProjectId(e.target.value)}
        >
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-4">
        {/* Provider */}
        <Field label="Provider" htmlFor="wf-provider">
          <select
            id="wf-provider"
            className={SELECT_CLASS}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">Project default</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_SHORT_LABELS[p]}
              </option>
            ))}
          </select>
        </Field>

        {/* Model */}
        <Field label="Model" htmlFor="wf-model" hint="Optional override.">
          <Input
            id="wf-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Default"
          />
        </Field>
      </div>

      {/* Agent */}
      <Field
        label="Agent"
        htmlFor="wf-agent"
        hint={loadingMeta ? undefined : "Discovered for the selected provider."}
      >
        <select
          id="wf-agent"
          className={SELECT_CLASS}
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value="">Default</option>
          {agentOptions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </Field>

      {/* Skills */}
      <Field label="Skills" htmlFor="wf-skills" hint="Toggle the skills to activate for runs.">
        <div
          id="wf-skills"
          role="group"
          aria-label="Skills"
          className="rounded-lg border border-input max-h-40 overflow-y-auto divide-y divide-border"
        >
          {loadingMeta ? (
            <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading skills…
            </div>
          ) : skillItems.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">
              No skills discovered for this provider/project.
            </p>
          ) : (
            skillItems.map((s) => (
              <label
                key={s.name}
                className="flex items-start gap-2 px-2.5 py-1.5 text-sm cursor-pointer hover:bg-accent/40"
              >
                <input
                  type="checkbox"
                  checked={skills.includes(s.name)}
                  onChange={() => toggleSkill(s.name)}
                  className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                  aria-label={s.name}
                />
                <span className="flex flex-col min-w-0">
                  <span className="font-medium truncate">{s.name}</span>
                  {s.description && (
                    <span
                      className={cn(
                        "text-xs truncate",
                        s.discovered ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"
                      )}
                    >
                      {s.description}
                    </span>
                  )}
                </span>
              </label>
            ))
          )}
        </div>
      </Field>

      {/* Cron + preview */}
      <Field
        label="Schedule (cron)"
        htmlFor="wf-cron"
        hint="Leave blank for a manual-only workflow."
      >
        <Input
          id="wf-cron"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          placeholder="0 9 * * *"
          className={cn("font-mono", !cronPreview.valid && "border-destructive")}
          aria-invalid={!cronPreview.valid}
        />
        <p
          role="status"
          className={cn(
            "mt-1.5 flex items-center gap-1.5 text-xs",
            cronPreview.valid ? "text-muted-foreground" : "text-destructive"
          )}
        >
          {cronPreview.valid ? (
            <Clock className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          <span>{cronPreview.label}</span>
        </p>
      </Field>

      {/* Watch path (file trigger) */}
      <Field
        label="Watch path (file trigger)"
        htmlFor="wf-watch-path"
        hint="Leave blank for no file trigger. A change under this path fires a run (debounced). Works alongside or instead of a cron schedule."
      >
        <div className="flex items-center gap-2">
          <Input
            id="wf-watch-path"
            value={watchPath}
            onChange={(e) => setWatchPath(e.target.value)}
            placeholder="/path/to/watch"
            className="font-mono"
          />
          <Button type="button" variant="outline" size="sm" onClick={handleBrowseWatchPath}>
            Browse…
          </Button>
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-4">
        {/* Session strategy */}
        <Field
          label="Session strategy"
          htmlFor="wf-strategy"
          hint={
            sessionStrategy === "fresh"
              ? "A new session each run."
              : "One long-lived session, accumulating context."
          }
        >
          <select
            id="wf-strategy"
            className={SELECT_CLASS}
            value={sessionStrategy}
            onChange={(e) => setSessionStrategy(e.target.value as WorkflowSessionStrategy)}
          >
            <option value="fresh">Fresh — new session per run</option>
            <option value="reuse">Reuse — one long-lived session</option>
          </select>
        </Field>

        {/* Autonomy */}
        <Field label="Autonomy" htmlFor="wf-autonomy">
          <select
            id="wf-autonomy"
            className={cn(
              SELECT_CLASS,
              autonomy === "autonomous" && "border-amber-500 text-amber-600 dark:text-amber-400"
            )}
            value={autonomy}
            onChange={(e) => setAutonomy(e.target.value as WorkflowAutonomy)}
          >
            <option value="interactive">Interactive — pauses for approval</option>
            <option value="autonomous">Autonomous — no human in the loop</option>
          </select>
        </Field>
      </div>

      {/* Autonomous warning */}
      {autonomy === "autonomous" && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Autonomous runs act with no human in the loop.</p>
            <p className="text-xs mt-0.5 opacity-90">
              The agent can write files and run shell commands using the project's
              trusted-tool allowlist without prompting for approval. Only enable this
              for tasks and projects you fully trust.
            </p>
          </div>
        </div>
      )}

      {/* Enabled */}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-input accent-primary"
        />
        <span>Enabled (the scheduler arms only enabled workflows)</span>
      </label>

      {error && (
        <p className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button onClick={handleSave} disabled={!canSave} size="sm">
          <Check className="h-4 w-4" />
          {saving ? "Saving…" : isEdit ? "Save changes" : "Create workflow"}
        </Button>
        <Button onClick={onCancel} variant="ghost" size="sm">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium leading-none">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
