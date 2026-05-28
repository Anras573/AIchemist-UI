import { useState, useCallback, useEffect } from "react";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useAgentTurn } from "@/lib/hooks/useAgentTurn";
import { useIpc } from "@/lib/ipc";
import { SplitPane } from "@/components/layout/SplitPane";
import { SessionTabBar } from "@/components/session/SessionTabBar";
import { TimelinePanel } from "@/components/session/TimelinePanel";
import { ContextPanel, type ContextTab } from "@/components/session/ContextPanel";
import { ToolStrip } from "@/components/session/ToolStrip";

export function WorkspaceView() {
  const ipc = useIpc();
  const { activeProjectId, projects } = useProjectStore();
  const { tabSwitchRequest, clearTabSwitchRequest, addSession, setActiveSession } = useSessionStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const { sendMessage } = useAgentTurn();

  // null = panel closed; a tab value = panel open on that tab
  const [activeTab, setActiveTab] = useState<ContextTab | null>("changes");
  const [showGitHubTab, setShowGitHubTab] = useState(false);

  const handleToolSelect = useCallback((tab: ContextTab) => {
    setActiveTab((current) => (current === tab ? null : tab));
  }, []);

  const handleAutoSwitch = useCallback((tab: ContextTab) => {
    setActiveTab(tab);
  }, []);

  // Consume store-level tab switch requests (e.g. from file change events)
  useEffect(() => {
    if (tabSwitchRequest) {
      setActiveTab(tabSwitchRequest as ContextTab);
      clearTabSwitchRequest();
    }
  }, [tabSwitchRequest, clearTabSwitchRequest]);

  const [createError, setCreateError] = useState<string | null>(null);
  useEffect(() => {
    setCreateError(null);
  }, [activeProjectId]);
  useEffect(() => {
    let cancelled = false;

    if (!activeProject?.path) {
      setShowGitHubTab(false);
      return;
    }

    void ipc.githubGetPrContext({ projectPath: activeProject.path })
      .then((context) => {
        if (cancelled) return;
        setShowGitHubTab(context.hasRemote);
      })
      .catch(() => {
        if (cancelled) return;
        setShowGitHubTab(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ipc, activeProject?.path]);

  useEffect(() => {
    if (!showGitHubTab && activeTab === "github") {
      setActiveTab("changes");
    }
  }, [activeTab, showGitHubTab]);

  const handleNewSession = useCallback(async (providerOverride?: string) => {
    if (!activeProjectId) return;
    setCreateError(null);
    try {
      const session = await ipc.createSession(activeProjectId, providerOverride);
      addSession(session);
      setActiveSession(session.id);
    } catch (err) {
      console.error("create_session failed:", err);
      setCreateError(err instanceof Error ? err.message : "Failed to create session");
    }
  }, [activeProjectId, addSession, setActiveSession, ipc]);

  if (!activeProject) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
        <p className="text-lg font-medium">No project open</p>
        <p className="text-sm">Add a project from the sidebar to get started.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="drag-region flex items-center border-b bg-background flex-shrink-0">
        <div className="no-drag-region flex-1 overflow-hidden">
          <SessionTabBar projectId={activeProject.id} />
        </div>
      </div>

      {/* Main content: chat | context panel | tool strip */}
      <div className="flex flex-1 overflow-hidden">
        <SplitPane
          left={<TimelinePanel onSendMessage={sendMessage} onNewSession={handleNewSession} createSessionError={createError} />}
          right={
            <ContextPanel
              activeTab={activeTab ?? "changes"}
              onClose={() => setActiveTab(null)}
              onAutoSwitch={handleAutoSwitch}
            />
          }
          rightCollapsed={activeTab === null}
        />
        <ToolStrip activeTab={activeTab} onSelect={handleToolSelect} showGitHubTab={showGitHubTab} />
      </div>
    </div>
  );
}
