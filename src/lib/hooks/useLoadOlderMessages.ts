import { useCallback, useRef } from "react";
import { useIpc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";

/**
 * Page size for "load older" fetches, triggered by Virtuoso's `startReached`
 * in `TimelinePanel.tsx`. Independent of `INITIAL_MESSAGE_PAGE_SIZE` — both
 * currently the same value, but there's no requirement that they match.
 */
export const OLDER_MESSAGES_PAGE_SIZE = 150;

/**
 * Returns a callback that fetches and prepends the next-older page of
 * messages for a session. Guards against overlapping fetches (e.g. Virtuoso
 * firing `startReached` more than once while still parked at the top) with a
 * per-session in-flight set that lives in a ref, not Zustand, since it's pure
 * fetch bookkeeping with no UI dependence.
 *
 * Resolves with the number of messages actually prepended (post de-dup) so
 * the caller can adjust Virtuoso's `firstItemIndex` by exactly that amount —
 * see the "Prepend Items" pattern in `TimelinePanel.tsx`.
 */
export function useLoadOlderMessages() {
  const ipc = useIpc();
  const prependMessages = useSessionStore((s) => s.prependMessages);
  const inFlight = useRef(new Set<string>());

  return useCallback(
    (sessionId: string, beforeMessageId: string): Promise<number> => {
      if (inFlight.current.has(sessionId)) return Promise.resolve(0);
      inFlight.current.add(sessionId);

      return ipc
        .getSession(sessionId, { limit: OLDER_MESSAGES_PAGE_SIZE, beforeMessageId })
        .then((session) => {
          if (!session) return 0;
          const existingIds = new Set(
            (useSessionStore.getState().sessions[sessionId]?.messages ?? []).map((m) => m.id)
          );
          const newCount = session.messages.filter((m) => !existingIds.has(m.id)).length;
          prependMessages(sessionId, session.messages, session.has_more_messages ?? false);
          return newCount;
        })
        .catch((err: unknown) => {
          console.error(err);
          return 0;
        })
        .finally(() => {
          inFlight.current.delete(sessionId);
        });
    },
    [ipc, prependMessages]
  );
}
