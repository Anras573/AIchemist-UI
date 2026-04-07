import { useEffect, useRef } from "react";
import { useIpc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";

/**
 * Fetches the full message history from SQLite whenever the active session
 * changes and hasn't been hydrated yet this session lifetime.
 *
 * The hydrated set lives in a ref (not Zustand) so it doesn't trigger re-renders
 * and resets on each page reload — meaning the DB is the source of truth on
 * every fresh app start.
 */
export function useSessionHydration() {
  const ipc = useIpc();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const hydrateSession = useSessionStore((s) => s.hydrateSession);
  const hydrated = useRef(new Set<string>());

  useEffect(() => {
    if (!activeSessionId) return;
    if (hydrated.current.has(activeSessionId)) return;

    hydrated.current.add(activeSessionId);

    ipc
      .getSession(activeSessionId)
      .then((session) => {
        if (session) hydrateSession(session);
      })
      .catch(console.error);
  }, [activeSessionId, hydrateSession]);
}
