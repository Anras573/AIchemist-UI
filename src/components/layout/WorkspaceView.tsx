import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useAgentTurn } from "@/lib/hooks/useAgentTurn";
import { SplitPane } from "@/components/layout/SplitPane";
import { SessionTabBar } from "@/components/session/SessionTabBar";
import { TimelinePanel } from "@/components/session/TimelinePanel";
import { ContextPanel } from "@/components/session/ContextPanel";
import { ModelPickerButton } from "@/components/session/ModelPickerButton";

export function WorkspaceView() {
  const { activeProjectId, projects } = useProjectStore();
  const { sessions, activeSessionId } = useSessionStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const { sendMessage } = useAgentTurn();

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
      {/* Tab bar + model picker — drag region for macOS window dragging */}
      <div className="drag-region flex items-center border-b bg-background flex-shrink-0">
        <div className="no-drag-region flex-1 overflow-hidden">
          <SessionTabBar projectId={activeProject.id} />
        </div>
        <div className="no-drag-region flex-shrink-0 pr-2 border-l ml-1 pl-2">
          {activeSession && (
            <ModelPickerButton
              sessionId={activeSession.id}
              provider={activeSession.provider}
              model={activeSession.model}
            />
          )}
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <SplitPane
          left={<TimelinePanel onSendMessage={sendMessage} />}
          right={<ContextPanel />}
        />
      </div>
    </div>
  );
}
