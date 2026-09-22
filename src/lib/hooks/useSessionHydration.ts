import { useEffect, useRef, useTransition } from "react";
import { useIpc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";

/**
 * Initial page size for session hydration — mirrors
 * `DEFAULT_MESSAGE_PAGE_SIZE` in `electron/sessions.ts` (the renderer can only
 * type-import from `electron/`, never value-import the Node-only module, so
 * the number is duplicated here; keep both in sync).
 */
export const INITIAL_MESSAGE_PAGE_SIZE = 150;

/**
 * Fetches the most recent page of message history from SQLite whenever the
 * active session changes and hasn't been hydrated yet this session lifetime.
 * Older messages are loaded on demand via `useLoadOlderMessages` as the user
 * scrolls up (Virtuoso's `startReached`) — see `TimelinePanel.tsx`.
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
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const hydrated = useRef(new Set<string>());
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (!activeSessionId) return;
    if (hydrated.current.has(activeSessionId)) return;

    hydrated.current.add(activeSessionId);

    ipc
      .getSession(activeSessionId, { limit: INITIAL_MESSAGE_PAGE_SIZE })
      .then((session) => {
        if (session) startTransition(() => hydrateSession(session));
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Session not found")) {
          // Stale persisted session ID — clear it so the UI shows the empty state.
          hydrated.current.delete(activeSessionId);
          setActiveSession(null);
        } else {
          console.error(err);
        }
      });
  }, [activeSessionId, hydrateSession, setActiveSession, startTransition]);
}
