import { useState, useEffect } from "react";
import { Loader2, Trash2 } from "lucide-react";
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
import type { SkillInfo } from "@/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultSkillContent(name: string) {
  return `---\nname: ${name}\ndescription: Brief description of what this skill does.\n---\n\nDescribe the capability or instructions this skill provides to the agent.\n`;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface SkillEditorModalProps {
  /** When set, we're editing an existing skill. When null, we're creating a new one. */
  skill: SkillInfo | null;
  /** Active project path. Used for project-scope skill creation. */
  projectPath: string;
  open: boolean;
  onClose: () => void;
  /** Called after a successful save or delete so the caller can refresh the list. */
  onSaved: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SkillEditorModal({
  skill,
  projectPath,
  open,
  onClose,
  onSaved,
}: SkillEditorModalProps) {
  const isNew = skill === null;

  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "project">("project");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Load SKILL.md content when editing an existing skill
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfirmDelete(false);

    if (isNew) {
      setName("");
      setScope("project");
      setContent(defaultSkillContent("my-skill"));
      return;
    }

    setLoading(true);
    ipc
      .readFile(`${skill!.path}/SKILL.md`)
      .then((result) => {
        if ("error" in result) {
          setError(`Could not read SKILL.md: ${result.error}`);
          setContent("");
        } else {
          setContent(result.content);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, skill, isNew]);

  const handleSave = async () => {
    setError(null);
    if (isNew) {
      const trimmed = name.trim();
      if (!trimmed) {
        setError("Skill name is required.");
        return;
      }
      if (/[\s/\\]/.test(trimmed)) {
        setError("Skill name must not contain spaces or slashes.");
        return;
      }
      setSaving(true);
      try {
        await ipc.createSkill({ name: trimmed, projectPath, scope, content });
        onSaved();
        onClose();
      } catch (e) {
        setError(`Failed to create skill: ${String(e)}`);
      } finally {
        setSaving(false);
      }
    } else {
      setSaving(true);
      try {
        await ipc.writeSkillFile({ skillPath: skill!.path, content });
        onSaved();
        onClose();
      } catch (e) {
        setError(`Failed to save skill: ${String(e)}`);
      } finally {
        setSaving(false);
      }
    }
  };

  const handleDelete = async () => {
    if (!skill?.path) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await ipc.deleteSkillDir(skill.path);
      onSaved();
      onClose();
    } catch (e) {
      setError(`Failed to delete skill: ${String(e)}`);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const title = isNew ? "New Skill" : `Edit Skill — ${skill!.name}`;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="max-w-2xl w-full"
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
                  placeholder="my-skill"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
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
            </div>
          )}

          {!isNew && skill && (
            <p className="text-[11px] text-muted-foreground font-mono truncate">
              {skill.path}/SKILL.md
            </p>
          )}

          <div>
            <label className="text-[11px] text-muted-foreground mb-1 block">
              SKILL.md content{" "}
              <span className="text-muted-foreground/60">(frontmatter + instructions)</span>
            </label>
            {loading ? (
              <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading…
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
          {!isNew && (
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
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || loading || deleting}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {isNew ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
