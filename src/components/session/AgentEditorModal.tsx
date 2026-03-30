import { useState, useEffect } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { AgentInfo } from "@/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

const streamdownPlugins = { cjk, code, math, mermaid };

function defaultAgentContent(name: string, description = "") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nWrite your agent system prompt here.\n`;
}

/** Strip YAML frontmatter (--- ... ---) from markdown content. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  return content.slice(end + 4).trimStart();
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface AgentEditorModalProps {
  /** When set, we're editing an existing agent. When null, we're creating a new one. */
  agent: AgentInfo | null;
  /** Provider for the session ("anthropic" | "copilot"). Needed for new agent creation. */
  provider: string;
  /** Active project path. Needed for copilot project-scope agents. */
  projectPath: string;
  open: boolean;
  onClose: () => void;
  /** Called after a successful save or delete so the caller can refresh the list. */
  onSaved: () => void;
  /** When true, shows content read-only without save/delete controls. */
  readOnly?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentEditorModal({
  agent,
  provider,
  projectPath,
  open,
  onClose,
  onSaved,
  readOnly = false,
}: AgentEditorModalProps) {
  const isNew = agent === null;

  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "project">("project");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Load file content when editing an existing agent
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfirmDelete(false);

    if (isNew) {
      setName("");
      setScope("project");
      setContent(defaultAgentContent("my-agent"));
      return;
    }

    if (!agent.path) {
      setContent("# This is a built-in agent and cannot be edited.");
      return;
    }

    setLoading(true);
    ipc
      .readFile(agent.path)
      .then((result) => {
        if ("error" in result) {
          setError(`Could not read agent file: ${result.error}`);
          setContent("");
        } else {
          setContent(result.content);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, agent, isNew]);

  const handleSave = async () => {
    setError(null);
    if (isNew) {
      const trimmed = name.trim();
      if (!trimmed) {
        setError("Agent name is required.");
        return;
      }
      // Validate name — no spaces or slashes
      if (/[\s/\\]/.test(trimmed)) {
        setError("Agent name must not contain spaces or slashes.");
        return;
      }
      setSaving(true);
      try {
        await ipc.createAgent({ provider, name: trimmed, projectPath, scope, content });
        onSaved();
        onClose();
      } catch (e) {
        setError(`Failed to create agent: ${String(e)}`);
      } finally {
        setSaving(false);
      }
    } else {
      if (!agent!.path) return;
      setSaving(true);
      try {
        await ipc.writeAgentFile({ filePath: agent!.path, content });
        onSaved();
        onClose();
      } catch (e) {
        setError(`Failed to save agent: ${String(e)}`);
      } finally {
        setSaving(false);
      }
    }
  };

  const handleDelete = async () => {
    if (!agent?.path) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await ipc.deleteAgentFile(agent.path);
      onSaved();
      onClose();
    } catch (e) {
      setError(`Failed to delete agent: ${String(e)}`);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const title = isNew ? "New Agent" : readOnly ? `Agent — ${agent!.name}` : `Edit Agent — ${agent!.name}`;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="sm:max-w-4xl w-full overflow-hidden"
        showCloseButton={!saving && !deleting}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {isNew && (
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-[11px] text-muted-foreground mb-1 block">Name</label>
                <input
                  className={cn(
                    "w-full rounded-md border bg-background px-2.5 py-1.5 text-sm font-mono",
                    "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  )}
                  placeholder="my-agent"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              {provider === "copilot" && (
                <div>
                  <label className="text-[11px] text-muted-foreground mb-1 block">Scope</label>
                  <select
                    className={cn(
                      "rounded-md border bg-background px-2.5 py-1.5 text-sm",
                      "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    )}
                    value={scope}
                    onChange={(e) => setScope(e.target.value as "global" | "project")}
                  >
                    <option value="project">Project</option>
                    <option value="global">Global</option>
                  </select>
                </div>
              )}
            </div>
          )}

          <div>
            {!readOnly && (
              <label className="text-[11px] text-muted-foreground mb-1 block">
                File content{" "}
                <span className="text-muted-foreground/60">(frontmatter + system prompt)</span>
              </label>
            )}
            {loading ? (
              <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading…
              </div>
            ) : readOnly ? (
              <div className="overflow-auto max-h-[60vh] rounded-md border bg-muted/10 px-4 py-3">
                <Streamdown
                  plugins={streamdownPlugins}
                  className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:overflow-x-auto [&_table]:overflow-x-auto [&_table]:block"
                >
                  {stripFrontmatter(content)}
                </Streamdown>
              </div>
            ) : (
              <textarea
                className={cn(
                  "w-full h-64 rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs leading-relaxed resize-y",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                )}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
              />
            )}
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          {!readOnly && !isNew && agent!.editable !== false && agent!.path && (
            <Button
              variant="destructive"
              size="sm"
              className="mr-auto"
              onClick={handleDelete}
              disabled={deleting || saving}
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {confirmDelete ? "Confirm Delete" : "Delete"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving || deleting}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || loading || deleting}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {isNew ? "Create" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
