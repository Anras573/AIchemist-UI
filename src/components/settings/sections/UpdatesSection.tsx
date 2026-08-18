import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIpc, onSessionEvent, IPC_CHANNELS } from "@/lib/ipc";
import type { UpdateStatus } from "@/types";

function statusLabel(status: UpdateStatus): string {
  switch (status.state) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Update v${status.version ?? "?"} available — downloading…`;
    case "downloading":
      return `Downloading v${status.version ?? "?"}${typeof status.percent === "number" ? ` — ${status.percent}%` : ""}`;
    case "downloaded":
      return `Update v${status.version ?? "?"} downloaded — ready to install.`;
    case "not-available":
      return "You're up to date.";
    case "error":
      return `Update check failed: ${status.error ?? "unknown error"}`;
    default:
      return "Not checked yet.";
  }
}

/** Manual "Check for updates" control + live status, backing the Advanced settings tab. Packaged builds only — checkForUpdates() no-ops in dev. */
export function UpdatesSection() {
  const ipc = useIpc();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    ipc
      .updateGetState()
      .then((s) => {
        setCurrentVersion(s.currentVersion);
        setStatus(s.status);
      })
      .catch(() => {});
    return onSessionEvent<UpdateStatus>(IPC_CHANNELS.UPDATE_STATUS, setStatus);
  }, [ipc]);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await ipc.updateCheck());
    } finally {
      setChecking(false);
    }
  }, [ipc]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
        <div>
          <p className="text-sm font-medium">AIchemist {currentVersion ? `v${currentVersion}` : ""}</p>
          <p className="text-xs text-muted-foreground">{statusLabel(status)}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void handleCheck()} disabled={checking}>
          {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Check for updates
        </Button>
      </div>
      {status.state === "downloaded" && (
        <Button size="sm" onClick={() => void ipc.updateInstall()}>
          Restart &amp; update to v{status.version}
        </Button>
      )}
    </div>
  );
}
