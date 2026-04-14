import { Files, Terminal, Blocks, Activity, GitCommitHorizontal, Server } from "lucide-react";
import type { ContextTab } from "./ContextPanel";
import { cn } from "@/lib/utils";

interface ToolStripItem {
  id: ContextTab;
  icon: React.ElementType;
  label: string;
}

const TOOLS: ToolStripItem[] = [
  { id: "files", icon: Files, label: "Files" },
  { id: "terminal", icon: Terminal, label: "Terminal" },
  { id: "skills", icon: Blocks, label: "Skills" },
  { id: "traces", icon: Activity, label: "Traces" },
  { id: "changes", icon: GitCommitHorizontal, label: "Changes" },
  { id: "mcp", icon: Server, label: "MCP" },
];

interface ToolStripProps {
  activeTab: ContextTab | null;
  onSelect: (tab: ContextTab) => void;
}

/**
 * Vertical icon strip on the far-right edge, inspired by JetBrains Rider.
 * Each button toggles the corresponding tool panel open/closed.
 * The active tool is highlighted; clicking it again closes the panel.
 */
export function ToolStrip({ activeTab, onSelect }: ToolStripProps) {
  return (
    <div className="flex flex-col items-center w-10 border-l bg-background shrink-0 py-1 gap-0.5">
      {TOOLS.map(({ id, icon: Icon, label }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => onSelect(id)}
            title={label}
            className={cn(
              "group relative flex flex-col items-center justify-center w-8 h-16 rounded-sm transition-colors gap-1",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {/* Rotated label */}
            <span
              className="text-[9px] font-medium leading-none select-none"
              style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
            >
              {label}
            </span>
            {/* Active indicator bar on the left edge */}
            {isActive && (
              <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
            )}
          </button>
        );
      })}
    </div>
  );
}
