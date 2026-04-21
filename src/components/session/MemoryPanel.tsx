import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { WithTooltip } from "@/components/ui/with-tooltip";

interface MemoryFile {
  name: string;
  path: string;
}

interface MemoryPanelProps {
  projectPath: string;
  onFileOpen: (path: string) => void;
}

/**
 * Lists Claude memory files (~/.claude/projects/<sanitized-cwd>/memory/*.md)
 * for the active project. Read-only — clicking a file opens it in the
 * shared FileViewer via the parent ContextPanel.
 */
export function MemoryPanel({ projectPath, onFileOpen }: MemoryPanelProps) {
  const ipc = useIpc();
  const [files, setFiles] = useState<MemoryFile[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    ipc
      .listMemory(projectPath)
      .then((r) => {
        if (!cancelled) setFiles(r.files);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  if (files === null) {
    return (
      <div className="p-3 text-xs text-muted-foreground">Loading…</div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        No memory files found for this project.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto py-1">
      {files.map((f) => (
        <WithTooltip key={f.path} label={f.path} side="left">
          <button
            onClick={() => onFileOpen(f.path)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/60 transition-colors"
            aria-label={f.name}
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{f.name}</span>
          </button>
        </WithTooltip>
      ))}
    </div>
  );
}
