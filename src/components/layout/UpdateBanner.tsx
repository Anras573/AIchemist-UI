import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIpc, onSessionEvent, IPC_CHANNELS } from "@/lib/ipc";
import type { UpdateStatus } from "@/types";

/**
 * Floating toast that only surfaces once there's something actionable: a
 * download in progress, or a downloaded update waiting for a restart. Silent
 * for "checking" / "not-available" / "error" — those are visible in Settings
 * → Advanced instead, so a transient background-check hiccup never interrupts
 * the user.
 */
export function UpdateBanner() {
  const ipc = useIpc();
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    ipc
      .updateGetState()
      .then((s) => setStatus(s.status))
      .catch(() => {});
    return onSessionEvent<UpdateStatus>(IPC_CHANNELS.UPDATE_STATUS, (s) => {
      setStatus(s);
      setDismissed(false);
    });
  }, [ipc]);

  if (dismissed) return null;
  if (status.state !== "downloading" && status.state !== "downloaded") return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-sm shadow-lg">
      <Download className="size-4 shrink-0 text-muted-foreground" />
      {status.state === "downloading" ? (
        <span>
          Downloading update{status.version ? ` v${status.version}` : ""}
          {typeof status.percent === "number" ? ` — ${status.percent}%` : "…"}
        </span>
      ) : (
        <>
          <span>Update{status.version ? ` v${status.version}` : ""} ready to install.</span>
          <Button size="sm" onClick={() => void ipc.updateInstall()}>
            Restart &amp; update
          </Button>
        </>
      )}
      <button
        type="button"
        aria-label="Dismiss update notification"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => setDismissed(true)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
