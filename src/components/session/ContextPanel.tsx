import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { ipc } from "@/lib/ipc";
import {
  FileTree,
  FileTreeFolder,
  FileTreeFile,
} from "@/components/ai-elements/file-tree";
import {
  Terminal,
  TerminalHeader,
  TerminalTitle,
  TerminalActions,
  TerminalCopyButton,
  TerminalClearButton,
  TerminalContent,
} from "@/components/ai-elements/terminal";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";

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
function LazyFolderChildren({ path }: { path: string }) {
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
            <LazyFolderChildren path={child.path} />
          </FileTreeFolder>
        ) : (
          <FileTreeFile key={child.path} name={child.name} path={child.path} />
        )
      )}
    </>
  );
}

function FileTreeNode({ entry }: { entry: DirEntry }) {
  if (entry.is_dir) {
    return (
      <FileTreeFolder name={entry.name} path={entry.path}>
        <LazyFolderChildren path={entry.path} />
      </FileTreeFolder>
    );
  }
  return <FileTreeFile name={entry.name} path={entry.path} />;
}

// ── FileTreeView ──────────────────────────────────────────────────────────────

interface FileTreeViewProps {
  projectPath: string;
}

function FileTreeView({ projectPath }: FileTreeViewProps) {
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
        <FileTreeNode key={entry.path} entry={entry} />
      ))}
    </FileTree>
  );
}

// ── TerminalView ──────────────────────────────────────────────────────────────

interface TerminalViewProps {
  sessionId: string;
}

function TerminalView({ sessionId }: TerminalViewProps) {
  const { terminalOutput, clearTerminalOutput } = useSessionStore();
  const output = terminalOutput[sessionId] ?? "";

  return (
    <Terminal
      output={output}
      onClear={() => clearTerminalOutput(sessionId)}
      className="border-0 rounded-none h-full"
    >
      <TerminalHeader>
        <TerminalTitle />
        <TerminalActions>
          <TerminalCopyButton />
          <TerminalClearButton />
        </TerminalActions>
      </TerminalHeader>
      <TerminalContent className="max-h-full flex-1" />
    </Terminal>
  );
}

// ── ContextPanel ──────────────────────────────────────────────────────────────

export type ContextTab = "files" | "terminal";

/**
 * Right panel content — renders whichever tool is active (files or terminal).
 * Tab switching and collapse are controlled externally via the ToolStrip.
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
  const { activeSessionId, liveToolCalls } = useSessionStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  // Auto-switch to terminal when an execute_bash call arrives
  const lastToolCall = activeSessionId
    ? (liveToolCalls[activeSessionId] ?? []).at(-1)
    : undefined;
  useEffect(() => {
    if (lastToolCall?.toolName === "execute_bash") {
      onAutoSwitch?.("terminal");
    }
  }, [lastToolCall, onAutoSwitch]);

  const label = activeTab === "files" ? "Files" : "Terminal";

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between h-9 px-3 border-b shrink-0 bg-background">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </span>
        <button
          onClick={onClose}
          className="flex items-center justify-center h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
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
          <FileTreeView projectPath={activeProject.path} />
        ) : activeSessionId ? (
          <TerminalView sessionId={activeSessionId} />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            No active session
          </div>
        )}
      </div>
    </div>
  );
}
