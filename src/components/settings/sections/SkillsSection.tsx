import { useState, useCallback } from "react";
import { AlertCircle, Eye, Loader2, Pencil, Plus, Search, X } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useIpcQuery } from "@/lib/hooks/useIpcQuery";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { SkillEditorModal } from "@/components/session/SkillEditorModal";
import type { Provider, SkillInfo } from "@/types";

// ── Source badge ────────────────────────────────────────────────────────────────

type SkillSource = "project" | "global" | "plugin";

const SOURCE_LABEL: Record<SkillSource, { label: string; className: string }> = {
  project: { label: "project", className: "text-blue-500" },
  global: { label: "global", className: "text-purple-500" },
  plugin: { label: "plugin", className: "text-amber-500" },
};

function SkillSourceBadge({ source, plugin }: { source?: string; plugin?: string }) {
  if (!source) return null;
  const meta = SOURCE_LABEL[source as SkillSource];
  if (!meta) return null;
  const label =
    source === "plugin" && plugin
      ? plugin.includes("/")
        ? plugin.slice(plugin.lastIndexOf("/") + 1)
        : plugin
      : meta.label;
  const title = source === "plugin" && plugin ? plugin : undefined;
  return (
    <span
      className={cn("text-[10px] font-medium shrink-0 truncate max-w-[160px]", meta.className)}
      title={title}
    >
      {label}
    </span>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface SkillsSectionProps {
  /** Resolved provider — active session's, falling back to the app default. */
  provider: Provider | null;
  /** Active project path. May be empty when the hub is opened standalone. */
  projectPath: string;
}

// ── Section ───────────────────────────────────────────────────────────────────

export function SkillsSection({ provider, projectPath }: SkillsSectionProps) {
  const ipc = useIpc();

  // Cache by project path + provider (the inputs that change scanned locations).
  // An empty project path is still a valid key — the backend returns the
  // global / plugin skills for the provider in that case.
  const skillsKey = `hub-skills:${projectPath}:${provider ?? ""}`;
  const { data, error, refetch } = useIpcQuery<SkillInfo[]>(skillsKey, () =>
    ipc.listSkills(projectPath, provider ?? undefined),
  );
  const skills = data ?? null;

  const [searchQuery, setSearchQuery] = useState("");

  // Modal state — undefined closed, null "new", SkillInfo "edit/view".
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null | undefined>(undefined);
  const [viewingSkill, setViewingSkill] = useState<SkillInfo | undefined>(undefined);
  const editorOpen = editingSkill !== undefined;
  const viewerOpen = viewingSkill !== undefined;

  const handleSaved = useCallback(() => {
    void refetch();
  }, [refetch]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleSkills =
    skills?.filter((s) => {
      if (!normalizedQuery) return true;
      return (
        s.name.toLowerCase().includes(normalizedQuery) ||
        (s.description?.toLowerCase().includes(normalizedQuery) ?? false) ||
        (s.plugin?.toLowerCase().includes(normalizedQuery) ?? false)
      );
    }) ?? null;

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search name, description, or plugin…"
          aria-label="Search skills"
          className="h-8 pl-8 pr-8 text-sm"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* List */}
      <div className="space-y-2">
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {String(error)}
          </div>
        ) : skills === null ? (
          <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading skills…
          </div>
        ) : skills.length === 0 ? (
          <div className="px-2 py-6 text-sm text-muted-foreground">
            No skills installed. Create one with the button below.
          </div>
        ) : visibleSkills && visibleSkills.length === 0 ? (
          <div className="px-2 py-6 text-sm text-muted-foreground">
            No skills match &ldquo;{searchQuery.trim()}&rdquo;.
          </div>
        ) : (
          visibleSkills!.map((skill) => {
            const isPlugin = skill.source === "plugin";
            return (
              <div
                key={`${skill.source ?? ""}:${skill.name}`}
                className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2.5"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{skill.name}</span>
                    <SkillSourceBadge source={skill.source} plugin={skill.plugin} />
                  </div>
                  {skill.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
                      {skill.description}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <WithTooltip label="View skill">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setViewingSkill(skill)}
                      aria-label="View skill"
                    >
                      <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </WithTooltip>
                  {!isPlugin && (
                    <WithTooltip label="Edit skill">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setEditingSkill(skill)}
                        aria-label="Edit skill"
                      >
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </WithTooltip>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* New */}
      <Button
        variant="outline"
        size="sm"
        className="w-full gap-1.5"
        onClick={() => setEditingSkill(null)}
      >
        <Plus className="h-4 w-4" />
        New Skill
      </Button>

      {editorOpen && (
        <SkillEditorModal
          skill={editingSkill ?? null}
          projectPath={projectPath}
          providerOverride={provider}
          open={editorOpen}
          onClose={() => setEditingSkill(undefined)}
          onSaved={handleSaved}
        />
      )}

      {viewerOpen && viewingSkill && (
        <SkillEditorModal
          skill={viewingSkill}
          projectPath={projectPath}
          providerOverride={provider}
          open={viewerOpen}
          onClose={() => setViewingSkill(undefined)}
          onSaved={() => setViewingSkill(undefined)}
          readOnly
        />
      )}
    </div>
  );
}
