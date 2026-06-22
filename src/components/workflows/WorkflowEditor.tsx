import { useMemo, useState } from "react";
import { useIpc } from "@/lib/ipc";
import { previewCron } from "@/lib/cron";
import { PROVIDERS, PROVIDER_SHORT_LABELS } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Check, Clock } from "lucide-react";
import type {
  Project,
  Provider,
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

/** Split a free-text skills field on commas/whitespace into a clean list. */
function parseSkills(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
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
  const [skills, setSkills] = useState((workflow?.skills ?? []).join(", "));
  const [cron, setCron] = useState(workflow?.cron ?? "");
  const [sessionStrategy, setSessionStrategy] = useState<WorkflowSessionStrategy>(
    workflow?.session_strategy ?? "fresh"
  );
  const [autonomy, setAutonomy] = useState<WorkflowAutonomy>(
    workflow?.autonomy ?? "interactive"
  );
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cronPreview = useMemo(() => previewCron(cron), [cron]);

  const canSave =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    projectId.length > 0 &&
    cronPreview.valid &&
    !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const parsedSkills = parseSkills(skills);
      const saved = await ipc.workflowUpsert({
        id: workflow?.id,
        projectId,
        name: name.trim(),
        prompt: prompt.trim(),
        provider: (provider || null) as Provider | null,
        model: model.trim() || null,
        agent: agent.trim() || null,
        skills: parsedSkills.length > 0 ? parsedSkills : null,
        cron: cron.trim() || null,
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

      <div className="grid grid-cols-2 gap-4">
        {/* Agent */}
        <Field label="Agent" htmlFor="wf-agent" hint="Optional agent name.">
          <Input
            id="wf-agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            placeholder="Default"
          />
        </Field>

        {/* Skills */}
        <Field label="Skills" htmlFor="wf-skills" hint="Comma-separated names.">
          <Input
            id="wf-skills"
            value={skills}
            onChange={(e) => setSkills(e.target.value)}
            placeholder="code-review, security-review"
          />
        </Field>
      </div>

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
