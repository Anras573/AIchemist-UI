import { useEffect, useState, useCallback } from "react";
import { Check, Eye, Loader2, Pencil, Plus } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SkillEditorModal } from "@/components/session/SkillEditorModal";
import type { SkillInfo } from "@/types";

const SOURCE_LABEL: Record<string, { label: string; className: string }> = {
  project: { label: "project", className: "text-blue-500/70" },
  global:  { label: "global",  className: "text-purple-500/70" },
  plugin:  { label: "plugin",  className: "text-amber-500/70" },
};

function SkillSourceBadge({ source }: { source?: string }) {
  if (!source) return null;
  const meta = SOURCE_LABEL[source];
  if (!meta) return null;
  return (
    <span className={cn("text-[9px] font-medium shrink-0", meta.className)}>
      {meta.label}
    </span>
  );
}

// ── SkillCard ─────────────────────────────────────────────────────────────────

function SkillCard({
  skill,
  active,
  onToggle,
  onView,
  onEdit,
}: {
  skill: SkillInfo;
  active: boolean;
  onToggle: () => void;
  onView: () => void;
  onEdit: () => void;
}) {
  return (
    <div
      className={cn(
        "w-full text-left rounded-md border px-3 py-2 transition-colors group relative",
        active
          ? "border-primary/40 bg-primary/5"
          : "border-border bg-background"
      )}
    >
      <button
        onClick={onToggle}
        className="w-full text-left hover:bg-transparent"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-semibold truncate">{skill.name}</span>
            <SkillSourceBadge source={skill.source} />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); onView(); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-opacity"
              title="View skill"
            >
              <Eye className="h-2.5 w-2.5 text-muted-foreground" />
            </button>
            {skill.source !== "plugin" && (
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-opacity"
                title="Edit skill"
              >
                <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
              </button>
            )}
            {active && <Check className="size-3 text-primary" />}
          </div>
        </div>
        {skill.description && (
          <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
            {skill.description}
          </p>
        )}
      </button>
    </div>
  );
}

// ── SkillsPanel ───────────────────────────────────────────────────────────────

export function SkillsPanel() {
  const ipc = useIpc();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const projectPath = activeProject?.path ?? "";

  const { activeSessionId, sessionSkills, setSessionSkills } = useSessionStore();
  const activeSkills = activeSessionId ? (sessionSkills[activeSessionId] ?? []) : [];

  const [skills, setSkills] = useState<SkillInfo[] | null>(null);

  // Modal state — undefined means closed, null means "new", SkillInfo means "edit/view"
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null | undefined>(undefined);
  const [viewingSkill, setViewingSkill] = useState<SkillInfo | undefined>(undefined);
  const modalOpen = editingSkill !== undefined;
  const viewModalOpen = viewingSkill !== undefined;

  const loadSkills = useCallback(() => {
    if (!projectPath) return;
    setSkills(null);
    ipc
      .listSkills(projectPath)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [projectPath]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const handleToggle = useCallback(
    (skillName: string) => {
      if (!activeSessionId) return;
      const next = activeSkills.includes(skillName)
        ? activeSkills.filter((s) => s !== skillName)
        : [...activeSkills, skillName];
      setSessionSkills(activeSessionId, next);
      ipc.updateSessionSkills(activeSessionId, next).catch(console.error);
    },
    [activeSessionId, activeSkills, setSessionSkills]
  );

  const handleModalClose = useCallback(() => setEditingSkill(undefined), []);
  const handleViewModalClose = useCallback(() => setViewingSkill(undefined), []);

  const handleModalSaved = useCallback(() => {
    loadSkills();
  }, [loadSkills]);

  return (
    <>
      <div className="flex flex-col h-full overflow-y-auto">
        <div className="p-2 flex flex-col gap-1.5">
          {skills === null ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[10px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading skills…
            </div>
          ) : skills.length === 0 ? (
            <div className="px-2 py-3 text-[10px] text-muted-foreground">
              No skills installed in{" "}
              <code className="font-mono">.agents/skills/</code>.
            </div>
          ) : (
            skills.map((skill) => (
              <SkillCard
                key={skill.name}
                skill={skill}
                active={activeSkills.includes(skill.name)}
                onToggle={() => handleToggle(skill.name)}
                onView={() => setViewingSkill(skill)}
                onEdit={() => skill.source !== "plugin" ? setEditingSkill(skill) : setViewingSkill(skill)}
              />
            ))
          )}
        </div>
        <div className="px-2 pb-2 mt-auto">
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5 text-xs"
            onClick={() => setEditingSkill(null)}
          >
            <Plus className="h-3 w-3" />
            New Skill
          </Button>
        </div>
      </div>

      {modalOpen && (
        <SkillEditorModal
          skill={editingSkill ?? null}
          projectPath={projectPath}
          open={modalOpen}
          onClose={handleModalClose}
          onSaved={handleModalSaved}
        />
      )}

      {viewModalOpen && viewingSkill && (
        <SkillEditorModal
          skill={viewingSkill}
          projectPath={projectPath}
          open={viewModalOpen}
          onClose={handleViewModalClose}
          onSaved={handleViewModalClose}
          readOnly
        />
      )}
    </>
  );
}
