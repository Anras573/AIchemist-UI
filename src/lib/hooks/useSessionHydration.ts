import { useEffect, useRef, useTransition } from "react";
import { useIpc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";

/**
 * Fetches the full message history from SQLite whenever the active session
 * changes and hasn't been hydrated yet this session lifetime.
 *
 * The hydrated set lives in a ref (not Zustand) so it doesn't trigger re-renders
 * and resets on each page reload — meaning the DB is the source of truth on
 * every fresh app start.
 *
 * useTransition defers the hydrateSession state update so it doesn't block
 * the render that triggered the session switch, preventing UI jank when
 * switching to a session with many messages.
 */
export function useSessionHydration() {
  const ipc = useIpc();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const hydrateSession = useSessionStore((s) => s.hydrateSession);
  const hydrated = useRef(new Set<string>());
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (!activeSessionId) return;
    if (hydrated.current.has(activeSessionId)) return;

    hydrated.current.add(activeSessionId);

    ipc
      .getSession(activeSessionId)
      .then((session) => {
        if (session) startTransition(() => hydrateSession(session));
      })
      .catch(console.error);
  }, [activeSessionId, hydrateSession, startTransition]);
}
