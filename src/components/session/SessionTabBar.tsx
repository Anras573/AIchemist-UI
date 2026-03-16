import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { Session } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/session/StatusDot";

interface SessionTabBarProps {
  projectId: string;
}

export function SessionTabBar({ projectId }: SessionTabBarProps) {
  const { sessions, activeSessionId, mergeSessions, setActiveSession, addSession, removeSession } =
    useSessionStore();

  const projectSessions = Object.values(sessions)
    .filter((s) => s.project_id === projectId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Load sessions for this project on mount and when projectId changes
  useEffect(() => {
    invoke<Session[]>("list_sessions", { projectId })
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
      const session = await invoke<Session>("create_session", { projectId });
      addSession(session);
      setActiveSession(session.id);
    } catch (err) {
      console.error("create_session failed:", err);
    }
  }, [projectId, addSession, setActiveSession]);

  const handleDeleteSession = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      await invoke("delete_session", { sessionId }).catch(console.error);
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
