import { useEffect, useState } from "react";
import { Bot, Blocks, CheckCircle2, AlertCircle, Eye, Loader2 } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { cn } from "@/lib/utils";
import { AgentEditorModal } from "@/components/session/AgentEditorModal";
import type { AgentInfo, SkillInfo } from "@/types";

// ── AgentCard ─────────────────────────────────────────────────────────────────

function AgentCard({
  agent,
  isSelected,
  onSelect,
  onView,
}: {
  agent: AgentInfo;
  isSelected: boolean;
  onSelect: () => void;
  onView: () => void;
}) {
  return (
    <div
      className={cn(
        "w-full text-left rounded-md border px-3 py-2 transition-colors group relative",
        isSelected
          ? "border-primary/50 bg-primary/5 text-foreground"
          : "border-border bg-background text-foreground"
      )}
    >
      <button
        onClick={onSelect}
        className="w-full text-left hover:bg-transparent"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold truncate">{agent.name}</span>
              {agent.model && (
                <span className="shrink-0 rounded px-1 py-0 text-[9px] font-medium bg-muted text-muted-foreground leading-4">
                  {agent.model}
                </span>
              )}
            </div>
            {agent.description && (
              <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
                {agent.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); onView(); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-opacity"
              title="View agent"
            >
              <Eye className="h-2.5 w-2.5 text-muted-foreground" />
            </button>
            {isSelected && (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary mt-0.5" />
            )}
          </div>
        </div>
      </button>
    </div>
  );
}

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

// ── Section ───────────────────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  label,
}: {
  icon: React.ElementType;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b bg-muted/30">
      <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

// ── AgentsPanel ───────────────────────────────────────────────────────────────

export function AgentsPanel() {
  const ipc = useIpc();
  const { activeSessionId, sessionAgents, setSessionAgent } = useSessionStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const provider = activeProject?.config.provider;
  const projectPath = activeProject?.path ?? "";

  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [viewingAgent, setViewingAgent] = useState<AgentInfo | undefined>(undefined);

  const selectedAgent = activeSessionId ? (sessionAgents[activeSessionId] ?? null) : null;

  // Load agents (Claude only)
  useEffect(() => {
    if (!projectPath || provider !== "anthropic") return;
    setAgents(null);
    setAgentsError(null);
    ipc
      .getClaudeAgents(projectPath)
      .then(setAgents)
      .catch((err) => setAgentsError(String(err)));
  }, [projectPath, provider]);

  // Load skills
  useEffect(() => {
    if (!projectPath) return;
    setSkills(null);
    ipc
      .listSkills(projectPath)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [projectPath]);

  function toggleAgent(name: string) {
    if (!activeSessionId) return;
    setSessionAgent(activeSessionId, selectedAgent === name ? null : name);
  }

  return (
    <>
      <div className="flex flex-col h-full overflow-y-auto">
      {/* ── Sub-agents section ─────────────────────────────────────── */}
      <SectionHeader icon={Bot} label="Sub-agents" />

      <div className="p-2 flex flex-col gap-1.5">
        {provider !== "anthropic" ? (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-[10px] text-muted-foreground">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
            Sub-agents are not available when using GitHub Copilot.
          </div>
        ) : agents === null && !agentsError ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[10px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading agents…
          </div>
        ) : agentsError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[10px] text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            {agentsError}
          </div>
        ) : agents && agents.length === 0 ? (
          <div className="px-2 py-3 text-[10px] text-muted-foreground">
            No sub-agents found.
          </div>
        ) : (
          agents?.map((agent) => (
            <AgentCard
              key={agent.name}
              agent={agent}
              isSelected={selectedAgent === agent.name}
              onSelect={() => toggleAgent(agent.name)}
              onView={() => setViewingAgent(agent)}
            />
          ))
        )}
      </div>

      {/* ── Skills section ─────────────────────────────────────────── */}
      <SectionHeader icon={Blocks} label="Skills" />

      <div className="p-2 flex flex-col gap-1.5">
        {skills === null ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[10px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading skills…
          </div>
        ) : skills.length === 0 ? (
          <div className="px-2 py-3 text-[10px] text-muted-foreground">
            No skills installed in <code className="font-mono">.agents/skills/</code>.
          </div>
        ) : (
          skills.map((skill) => <SkillCard key={skill.name} skill={skill} />)
        )}
      </div>
    </div>

    {viewingAgent && (
      <AgentEditorModal
        agent={viewingAgent}
        provider={provider ?? ""}
        projectPath={projectPath}
        open={true}
        onClose={() => setViewingAgent(undefined)}
        onSaved={() => setViewingAgent(undefined)}
        readOnly
      />
    )}
    </>
  );
}
