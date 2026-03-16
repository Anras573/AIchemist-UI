import { useProjectStore } from "@/lib/store/useProjectStore";
import { useAgentTurn } from "@/lib/hooks/useAgentTurn";
import { SplitPane } from "@/components/layout/SplitPane";
import { SessionTabBar } from "@/components/session/SessionTabBar";
import { TimelinePanel } from "@/components/session/TimelinePanel";
import { ContextPanel } from "@/components/session/ContextPanel";
import { ModelPickerButton } from "@/components/session/ModelPickerButton";

export function WorkspaceView() {
  const { activeProjectId, projects } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
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
      {/* Tab bar + model picker in the same row */}
      <div className="flex items-center border-b bg-background flex-shrink-0">
        <div className="flex-1 overflow-hidden">
          <SessionTabBar projectId={activeProject.id} />
        </div>
        <div className="flex-shrink-0 pr-2 border-l ml-1 pl-2">
          <ModelPickerButton project={activeProject} />
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
