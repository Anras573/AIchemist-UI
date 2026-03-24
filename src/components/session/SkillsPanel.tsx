import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { SkillInfo } from "@/types";

// ── SkillCard ─────────────────────────────────────────────────────────────────

function SkillCard({ skill }: { skill: SkillInfo }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="text-xs font-semibold">{skill.name}</div>
      {skill.description && (
        <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
          {skill.description}
        </p>
      )}
    </div>
  );
}

// ── SkillsPanel ───────────────────────────────────────────────────────────────

export function SkillsPanel() {
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const projectPath = activeProject?.path ?? "";

  const [skills, setSkills] = useState<SkillInfo[] | null>(null);

  useEffect(() => {
    if (!projectPath) return;
    setSkills(null);
    ipc
      .listSkills(projectPath)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [projectPath]);

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
          skills.map((skill) => <SkillCard key={skill.name} skill={skill} />)
        )}
      </div>
    </div>
  );
}
