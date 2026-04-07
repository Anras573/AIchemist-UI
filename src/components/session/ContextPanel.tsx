import { useEffect, useState } from "react";
import { X, ChevronLeft } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import {
  FileTree,
  FileTreeFolder,
  FileTreeFile,
} from "@/components/ai-elements/file-tree";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { FileViewer } from "./FileViewer";
import { SkillsPanel } from "./SkillsPanel";
import { TracesPanel } from "./TracesPanel";
import { ChangesPanel } from "./ChangesPanel";
import { InteractiveTerminal } from "./InteractiveTerminal";

// ── Rust types ────────────────────────────────────────────────────────────────

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes: number;
}

// ── Sorting — folders first, then files, each group alphabetical ─────────────

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

// ── FileTreeNode — recursive, lazy-loading ────────────────────────────────────

/**
 * Lazily-loaded folder node.
 * Children are fetched the first time the folder is rendered
 * (i.e., when its parent was expanded).
 */
function LazyFolderChildren({
  path,
  onFileOpen,
}: {
  path: string;
  onFileOpen?: (path: string) => void;
}) {
  const ipc = useIpc();
  const [children, setChildren] = useState<DirEntry[] | null>(null);

  useEffect(() => {
    ipc.listDirectory(path)
      .then((r) => setChildren(r.entries))
      .catch(() => setChildren([]));
  }, [path]);

  if (!children) {
    return (
      <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>
    );
  }

  return (
    <>
      {sortEntries(children).map((child) =>
        child.is_dir ? (
          <FileTreeFolder key={child.path} name={child.name} path={child.path}>
            <LazyFolderChildren path={child.path} onFileOpen={onFileOpen} />
          </FileTreeFolder>
        ) : (
          // Wrap in a div so the click can be intercepted for the file viewer
          <div key={child.path} onClick={() => onFileOpen?.(child.path)}>
            <FileTreeFile name={child.name} path={child.path} />
          </div>
        )
      )}
    </>
  );
}

function FileTreeNode({
  entry,
  onFileOpen,
}: {
  entry: DirEntry;
  onFileOpen?: (path: string) => void;
}) {
  if (entry.is_dir) {
    return (
      <FileTreeFolder name={entry.name} path={entry.path}>
        <LazyFolderChildren path={entry.path} onFileOpen={onFileOpen} />
      </FileTreeFolder>
    );
  }
  return (
    <div onClick={() => onFileOpen?.(entry.path)}>
      <FileTreeFile name={entry.name} path={entry.path} />
    </div>
  );
}

// ── FileTreeView ──────────────────────────────────────────────────────────────

interface FileTreeViewProps {
  projectPath: string;
  onFileOpen?: (path: string) => void;
}

function FileTreeView({ projectPath, onFileOpen }: FileTreeViewProps) {
  const ipc = useIpc();
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEntries(null);
    setError(null);
    ipc.listDirectory(projectPath)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(String(e)));
  }, [projectPath]);

  if (error) {
    return (
      <div className="p-3 text-xs text-destructive">
        Failed to load directory: {error}
      </div>
    );
  }

  if (!entries) {
    return (
      <div className="p-3 text-xs text-muted-foreground">Loading…</div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        Directory is empty
      </div>
    );
  }

  return (
    <FileTree
      selectedPath={selectedPath}
      onSelect={setSelectedPath}
      className="border-0 rounded-none h-full overflow-y-auto"
    >
      {sortEntries(entries).map((entry) => (
        <FileTreeNode key={entry.path} entry={entry} onFileOpen={onFileOpen} />
      ))}
    </FileTree>
  );
}

// ── ContextPanel ──────────────────────────────────────────────────────────────

export type ContextTab = "files" | "terminal" | "skills" | "traces" | "changes";

/**
 * Right panel content — renders whichever tool is active (files or terminal).
 * Tab switching and collapse are controlled externally via the ToolStrip.
 * When a file is clicked in the tree it opens an inline file viewer.
 */
export function ContextPanel({
  activeTab,
  onClose,
  onAutoSwitch,
}: {
  activeTab: ContextTab;
  onClose: () => void;
  onAutoSwitch?: (tab: ContextTab) => void;
}) {
  const { liveToolCalls, activeSessionId } = useSessionStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const [viewingFile, setViewingFile] = useState<string | null>(null);

  // Auto-switch to terminal when an execute_bash call arrives
  const lastToolCall = activeSessionId
    ? (liveToolCalls[activeSessionId] ?? []).at(-1)
    : undefined;
  useEffect(() => {
    if (lastToolCall?.toolName === "execute_bash") {
      onAutoSwitch?.("terminal");
    }
  }, [lastToolCall, onAutoSwitch]);

  // Clear file viewer when switching away from the Files tab
  useEffect(() => {
    if (activeTab !== "files") setViewingFile(null);
  }, [activeTab]);

  // Header content depends on whether we're viewing a file
  const isViewingFile = activeTab === "files" && viewingFile !== null;
  const fileName = viewingFile?.split("/").pop() ?? "";
  const headerLabel = isViewingFile ? fileName : activeTab === "files" ? "Files" : activeTab === "terminal" ? "Terminal" : activeTab === "traces" ? "Traces" : activeTab === "changes" ? "Changes" : "Skills";

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center h-9 px-2 border-b shrink-0 bg-background gap-1">
        {isViewingFile && (
          <button
            onClick={() => setViewingFile(null)}
            className="flex items-center justify-center h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
            title="Back to file tree"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-1 truncate">
          {headerLabel}
        </span>
        <button
          onClick={onClose}
          className="flex items-center justify-center h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          title="Close panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {!activeProject ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            No project open
          </div>
        ) : activeTab === "files" ? (
          isViewingFile ? (
            <FileViewer filePath={viewingFile!} />
          ) : (
            <FileTreeView
              projectPath={activeProject.path}
              onFileOpen={setViewingFile}
            />
          )
        ) : activeTab === "skills" ? (
          <SkillsPanel />
        ) : activeTab === "traces" ? (
          <TracesPanel />
        ) : activeTab === "changes" ? (
          <ChangesPanel />
        ) : activeTab === "terminal" ? (
          activeProject ? (
            <InteractiveTerminal projectPath={activeProject.path} />
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              No project open
            </div>
          )
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            No active session
          </div>
        )}
      </div>
    </div>
  );
}
