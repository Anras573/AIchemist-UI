import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

// ── FileTreeNode — recursive, lazy-loading ────────────────────────────────────

/**
 * Lazily-loaded folder node.
 * Children are fetched the first time the folder is rendered
 * (i.e., when its parent was expanded).
 */
function LazyFolderChildren({ path }: { path: string }) {
  const [children, setChildren] = useState<DirEntry[] | null>(null);

  useEffect(() => {
    invoke<{ entries: DirEntry[] }>("list_directory", { path })
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
      {children.map((child) =>
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
    invoke<{ entries: DirEntry[] }>("list_directory", { path: projectPath })
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
      {entries.map((entry) => (
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

/**
 * Right panel: tabbed view showing the active project's file tree and
 * terminal output from bash tool calls. Auto-switches to the Terminal tab
 * when an execute_bash call arrives.
 */
export function ContextPanel() {
  const { activeSessionId, liveToolCalls } = useSessionStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  // Derive active tab from the most recent live tool call category
  const lastToolCall = activeSessionId
    ? (liveToolCalls[activeSessionId] ?? []).at(-1)
    : undefined;
  const autoTab =
    lastToolCall?.toolName === "execute_bash" ? "terminal" : "files";

  const [tab, setTab] = useState<"files" | "terminal">("files");

  // Auto-switch when a new tool call arrives
  useEffect(() => {
    if (lastToolCall) setTab(autoTab as "files" | "terminal");
  }, [lastToolCall, autoTab]);

  if (!activeProject) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        No project open
      </div>
    );
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as "files" | "terminal")}
      className="flex flex-col h-full"
    >
      <TabsList className="shrink-0 rounded-none border-b bg-transparent justify-start px-2 h-9 gap-1">
        <TabsTrigger value="files" className="text-xs h-7 px-3">
          Files
        </TabsTrigger>
        <TabsTrigger value="terminal" className="text-xs h-7 px-3">
          Terminal
        </TabsTrigger>
      </TabsList>

      <TabsContent value="files" className="flex-1 overflow-hidden m-0 p-0">
        <FileTreeView projectPath={activeProject.path} />
      </TabsContent>

      <TabsContent value="terminal" className="flex-1 overflow-hidden m-0 p-0">
        {activeSessionId ? (
          <TerminalView sessionId={activeSessionId} />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            No active session
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
