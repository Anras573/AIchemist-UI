import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { ProviderProbes } from "@/types";

/**
 * Fetches provider availability probes (Anthropic / Copilot / ACP) and keeps
 * them fresh on:
 *  - mount
 *  - window focus (the 30 s backend cache absorbs spurious focus events)
 *  - explicit `refresh()` from a UI button
 *
 * Pass `projectId` to include the per-project ACP probe; otherwise only
 * `anthropic` and `copilot` are returned.
 */
export function useProviderProbes(projectId?: string): {
  probes: ProviderProbes | null;
  checking: boolean;
  refresh: (force?: boolean) => Promise<void>;
} {
  const [probes, setProbes] = useState<ProviderProbes | null>(null);
  const [checking, setChecking] = useState<boolean>(false);
  // Track the latest projectId so a stale resolve doesn't overwrite newer state.
  const generation = useRef(0);

  const refresh = useCallback(
    async (force = false) => {
      const myGen = ++generation.current;
      setChecking(true);
      try {
        const result = await ipc.probeProviders({ projectId, force });
        if (myGen !== generation.current) return;
        setProbes(result);
      } catch (err) {
        if (myGen !== generation.current) return;
        // Surface as not-ok for everything so the UI doesn't lock the user out
        // forever; the cause is logged for debugging.
        console.error("[useProviderProbes] probe failed", err);
        setProbes({
          anthropic: { ok: false, reason: "Probe IPC failed" },
          copilot: { ok: false, reason: "Probe IPC failed" },
          ...(projectId ? { acp: { ok: false, reason: "Probe IPC failed" } } : {}),
        });
      } finally {
        if (myGen === generation.current) setChecking(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void refresh(false);
    const onFocus = () => {
      void refresh(false);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { probes, checking, refresh };
}
