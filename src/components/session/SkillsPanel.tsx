import { useEffect, useState, useCallback, useMemo } from "react";
import { Check, Eye, Info, Loader2, Pencil, Plus } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useActiveSessionProvider } from "@/lib/hooks/useActiveSessionProvider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { SkillEditorModal } from "@/components/session/SkillEditorModal";
import type { SkillInfo } from "@/types";

const SOURCE_LABEL: Record<string, { label: string; className: string }> = {
  project: { label: "project", className: "text-blue-500/70" },
  global:  { label: "global",  className: "text-purple-500/70" },
  plugin:  { label: "plugin",  className: "text-amber-500/70" },
};

function SkillSourceBadge({ source, plugin }: { source?: string; plugin?: string }) {
  if (!source) return null;
  const meta = SOURCE_LABEL[source];
  if (!meta) return null;

  // For plugin skills, show the short repo name (after last "/") with full key as tooltip
  const label = source === "plugin" && plugin
    ? (plugin.includes("/") ? plugin.slice(plugin.lastIndexOf("/") + 1) : plugin)
    : meta.label;
  const title = source === "plugin" && plugin ? plugin : undefined;

  return (
    <span className={cn("text-[9px] font-medium shrink-0 truncate max-w-[140px]", meta.className)} title={title}>
      {label}
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
            <SkillSourceBadge source={skill.source} plugin={skill.plugin} />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <WithTooltip label="View skill">
              <button
                onClick={(e) => { e.stopPropagation(); onView(); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-opacity"
                aria-label="View skill"
              >
                <Eye className="h-2.5 w-2.5 text-muted-foreground" />
              </button>
            </WithTooltip>
            {skill.source !== "plugin" && (
              <WithTooltip label="Edit skill">
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit(); }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-opacity"
                  aria-label="Edit skill"
                >
                  <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
                </button>
              </WithTooltip>
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
  const provider = useActiveSessionProvider();

  const [skills, setSkills] = useState<SkillInfo[] | null>(null);

  // Copilot sessions only get project-local skills; the global (~/.claude/skills)
  // and plugin sources are Claude-specific.
  const visibleSkills = useMemo(() => {
    if (!skills) return null;
    if (provider === "copilot") {
      return skills.filter((s) => s.source === "project");
    }
    return skills;
  }, [skills, provider]);

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
        <div className="flex items-center justify-end px-2 pt-1.5 pb-0.5">
          <WithTooltip
            label={
              <div className="flex flex-col gap-1 max-w-[260px] text-[11px]">
                <span className="font-medium">Skills are loaded from:</span>
                <ul className="space-y-0.5">
                  <li>
                    <span className="text-blue-300">project</span> ·{" "}
                    <code>&lt;project&gt;/.agents/skills/</code>
                  </li>
                  {provider !== "copilot" && (
                    <>
                      <li>
                        <span className="text-purple-300">global</span> ·{" "}
                        <code>~/.claude/skills/</code>
                      </li>
                      <li>
                        <span className="text-amber-300">plugin</span> ·
                        installed Claude Code plugins
                      </li>
                    </>
                  )}
                </ul>
                {provider === "copilot" ? (
                  <span className="text-muted-foreground">
                    Copilot sessions only see project-local skills. Global and
                    plugin skills are Claude-specific.
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Higher-priority sources override same-named skills below.
                  </span>
                )}
              </div>
            }
            side="left"
          >
            <button
              type="button"
              aria-label="About skills sources"
              className="flex items-center justify-center h-5 w-5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Info className="h-3 w-3" />
            </button>
          </WithTooltip>
        </div>
        <div className="p-2 pt-1 flex flex-col gap-1.5">
          {visibleSkills === null ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[10px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading skills…
            </div>
          ) : visibleSkills.length === 0 ? (
            <div className="px-2 py-3 text-[10px] text-muted-foreground">
              No skills installed in{" "}
              <code className="font-mono">.agents/skills/</code>.
            </div>
          ) : (
            visibleSkills.map((skill) => (
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
