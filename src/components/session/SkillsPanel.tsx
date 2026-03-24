import { useEffect, useState, useCallback } from "react";
import { Check, Loader2 } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { cn } from "@/lib/utils";
import type { SkillInfo } from "@/types";

// ── SkillCard ─────────────────────────────────────────────────────────────────

function SkillCard({
  skill,
  active,
  onToggle,
}: {
  skill: SkillInfo;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        "w-full text-left rounded-md border px-3 py-2 transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        active
          ? "border-primary/40 bg-primary/5"
          : "border-border bg-background"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold truncate">{skill.name}</span>
        {active && <Check className="size-3 shrink-0 text-primary" />}
      </div>
      {skill.description && (
        <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
          {skill.description}
        </p>
      )}
    </button>
  );
}

// ── SkillsPanel ───────────────────────────────────────────────────────────────

export function SkillsPanel() {
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const projectPath = activeProject?.path ?? "";

  const { activeSessionId, sessionSkills, setSessionSkills } = useSessionStore();
  const activeSkills = activeSessionId ? (sessionSkills[activeSessionId] ?? []) : [];

  const [skills, setSkills] = useState<SkillInfo[] | null>(null);

  useEffect(() => {
    if (!projectPath) return;
    setSkills(null);
    ipc
      .listSkills(projectPath)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [projectPath]);

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

  return (
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
            />
          ))
        )}
      </div>
    </div>
  );
}
