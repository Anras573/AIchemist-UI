import { useEffect, useRef } from "react";
import { Bot, FileText, HelpCircle, PlusCircle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SkillInfo } from "@/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SlashAction = {
  type: "action";
  id: "new" | "clear" | "help" | "agent";
  label: string;
  description: string;
};

export type SlashSkillItem = {
  type: "skill";
  skill: SkillInfo;
};

export type SlashItem = SlashAction | SlashSkillItem;

export const BUILTIN_ACTIONS: SlashAction[] = [
  { type: "action", id: "new",   label: "new",   description: "Start a new session" },
  { type: "action", id: "clear", label: "clear", description: "Clear the current timeline" },
  { type: "action", id: "agent", label: "agent", description: "Open the agent picker" },
  { type: "action", id: "help",  label: "help",  description: "Show available slash commands" },
];

/** Computes filtered items for a given slash query + skill list. */
export function buildSlashItems(query: string, skills: SkillInfo[]): SlashItem[] {
  const q = query.toLowerCase();
  const actions: SlashItem[] = BUILTIN_ACTIONS
    .filter((a) => a.label.startsWith(q));
  const skillItems: SlashItem[] = skills
    .filter((s) => s.name.toLowerCase().startsWith(q))
    .map((s) => ({ type: "skill", skill: s }));
  return [...actions, ...skillItems];
}

function getItemKey(item: SlashItem): string {
  return item.type === "action" ? `action:${item.id}` : `skill:${item.skill.name}`;
}

function getItemLabel(item: SlashItem): string {
  return item.type === "action" ? item.label : item.skill.name;
}

function getItemDescription(item: SlashItem): string {
  return item.type === "action" ? item.description : item.skill.description;
}

// ── Icon ──────────────────────────────────────────────────────────────────────

function ItemIcon({ item }: { item: SlashItem }) {
  if (item.type === "skill") return <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />;
  switch (item.id) {
    case "new":   return <PlusCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
    case "clear": return <Trash2     className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
    case "agent": return <Bot        className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
    case "help":  return <HelpCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
}

// ── Popover ───────────────────────────────────────────────────────────────────

interface SlashCommandPopoverProps {
  items: SlashItem[];
  selectedIndex: number;
  loadingSkills: boolean;
  onSelect: (item: SlashItem) => void;
}

export function SlashCommandPopover({
  items,
  selectedIndex,
  loadingSkills,
  onSelect,
}: SlashCommandPopoverProps) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  // Scroll the selected item into view when selection changes via keyboard
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const skillItems  = items.filter((i): i is SlashSkillItem => i.type === "skill");
  const actionItems = items.filter((i): i is SlashAction    => i.type === "action");

  if (!loadingSkills && items.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1 rounded-md border border-border bg-popover shadow-md text-[11px] text-muted-foreground px-3 py-2">
        No matching commands
      </div>
    );
  }

  let runningIndex = 0;

  const renderItem = (item: SlashItem) => {
    const idx = runningIndex++;
    const isSelected = idx === selectedIndex;
    return (
      <button
        key={getItemKey(item)}
        ref={isSelected ? selectedRef : null}
        onClick={() => onSelect(item)}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors",
          isSelected
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent/50 text-foreground"
        )}
      >
        <ItemIcon item={item} />
        <span className="text-xs font-medium shrink-0">/{getItemLabel(item)}</span>
        {getItemDescription(item) && (
          <span className="text-[10px] text-muted-foreground truncate">
            {getItemDescription(item)}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 rounded-md border border-border bg-popover shadow-md overflow-hidden">
      <div className="max-h-56 overflow-y-auto p-1">
        {/* Skills section */}
        {actionItems.length > 0 && (
          <div>
            {skillItems.length > 0 && (
              <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                Actions
              </div>
            )}
            {actionItems.map(renderItem)}
          </div>
        )}

        {/* Divider */}
        {actionItems.length > 0 && skillItems.length > 0 && (
          <div className="my-1 border-t border-border" />
        )}

        {/* Skills section */}
        {(skillItems.length > 0 || loadingSkills) && (
          <div>
            {actionItems.length > 0 && skillItems.length > 0 && (
              <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                Skills
              </div>
            )}
            {loadingSkills && skillItems.length === 0 ? (
              <div className="px-2 py-1.5 text-[10px] text-muted-foreground">
                Loading skills…
              </div>
            ) : (
              skillItems.map(renderItem)
            )}
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="border-t border-border px-2.5 py-1 flex gap-3 text-[9px] text-muted-foreground/60">
        <span>↑↓ navigate</span>
        <span>↵ select</span>
        <span>Esc close</span>
      </div>
    </div>
  );
}
