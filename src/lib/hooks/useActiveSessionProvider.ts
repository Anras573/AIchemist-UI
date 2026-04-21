import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";

export type SessionProvider = "anthropic" | "copilot";

/**
 * Returns the effective provider for the active session.
 *
 * Resolution order:
 *   1. The session's own `provider` (set when the session was created)
 *   2. The active project's default provider (legacy sessions, pre-provider-lock)
 *   3. `null` if neither is available (no active session/project)
 */
export function useActiveSessionProvider(): SessionProvider | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const session = useSessionStore((s) =>
    activeSessionId ? s.sessions[activeSessionId] : undefined,
  );
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = useProjectStore((s) =>
    s.projects.find((p) => p.id === activeProjectId),
  );

  const raw = session?.provider ?? project?.config.provider ?? null;
  if (raw === "anthropic" || raw === "copilot") return raw;
  return null;
}
