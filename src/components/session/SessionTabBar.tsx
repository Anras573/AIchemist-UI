import { useEffect, useCallback } from "react";
import { Bot } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/session/StatusDot";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { getModelLabel, getLogoProvider } from "@/lib/models";

interface SessionTabBarProps {
  projectId: string;
}

export function SessionTabBar({ projectId }: SessionTabBarProps) {
  const { sessions, activeSessionId, sessionAgents, mergeSessions, setActiveSession, addSession, removeSession } =
    useSessionStore();

  const projectSessions = Object.values(sessions)
    .filter((s) => s.project_id === projectId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Load sessions for this project on mount and when projectId changes
  useEffect(() => {
    // Immediately clear the active session so no stale session from another
    // project is shown while the new project's sessions are loading.
    setActiveSession(null);
    ipc.listSessions(projectId)
      .then((list) => {
        mergeSessions(list);
        // Restore last active session if it belongs to this project, else pick first
        const currentActive = useSessionStore.getState().activeSessionId;
        const belongsHere = list.some((s) => s.id === currentActive);
        if (!belongsHere && list.length > 0) {
          setActiveSession(list[0].id);
        }
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const handleNewSession = useCallback(async () => {
    try {
      const session = await ipc.createSession(projectId);
      addSession(session);
      setActiveSession(session.id);
    } catch (err) {
      console.error("create_session failed:", err);
    }
  }, [projectId, addSession, setActiveSession]);

  const handleDeleteSession = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      await ipc.deleteSession(sessionId).catch(console.error);
      removeSession(sessionId);
    },
    [removeSession]
  );

  return (
    <div className="flex items-center h-9 border-b bg-background overflow-x-auto flex-shrink-0">
      <div className="flex items-center min-w-0 flex-1 gap-0.5 px-1">
        {projectSessions.length === 0 && (
          <span className="text-xs text-muted-foreground px-2">No sessions yet</span>
        )}
        {projectSessions.map((session) => {
          const active = session.id === activeSessionId;
          const sessionModelLabel = session.model
            ? getModelLabel(session.provider ?? "", session.model)
            : null;
          const sessionLogoProvider = session.provider
            ? getLogoProvider(session.provider)
            : null;
          const sessionAgent = sessionAgents[session.id] ?? null;
          return (
            <div key={session.id} className="group relative flex-shrink-0">
              <button
                onClick={() => setActiveSession(session.id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1 h-9 text-xs rounded-none border-b-2 transition-colors whitespace-nowrap",
                  "hover:bg-accent hover:text-accent-foreground",
                  active
                    ? "border-primary text-foreground font-medium"
                    : "border-transparent text-muted-foreground"
                )}
              >
                <StatusDot status={session.status} />
                <span className="max-w-32 truncate">{session.title}</span>
                {/* Model badge — shown on the active tab */}
                {active && sessionModelLabel && sessionLogoProvider && (
                  <span className="flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded text-[10px] font-normal text-muted-foreground bg-muted/60 border border-border/50">
                    <ModelSelectorLogo provider={sessionLogoProvider} className="size-2.5 opacity-60" />
                    {sessionModelLabel}
                  </span>
                )}
                {/* Agent badge — shown on all tabs where an agent is selected */}
                {sessionAgent && (
                  <span className={cn(
                    "flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded text-[10px] font-normal",
                    active
                      ? "text-primary bg-primary/10 border border-primary/30"
                      : "text-muted-foreground bg-muted/60 border border-border/50"
                  )}>
                    <Bot className="size-2.5 shrink-0" />
                    <span className="max-w-[80px] truncate">{sessionAgent}</span>
                  </span>
                )}
                {/* Close button — visible on hover */}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => handleDeleteSession(e, session.id)}
                  onKeyDown={(e) => e.key === "Enter" && handleDeleteSession(e as unknown as React.MouseEvent, session.id)}
                  className="ml-0.5 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity leading-none"
                  title="Close session"
                >
                  ×
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {/* New session button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 flex-shrink-0 text-muted-foreground hover:text-foreground rounded-none"
        onClick={handleNewSession}
        title="New session"
      >
        +
      </Button>
    </div>
  );
}
