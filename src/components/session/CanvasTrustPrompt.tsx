import { useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { IpcError, useIpc } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import type { CanvasTrustStatus } from "@/types";

interface CanvasTrustPromptProps {
  projectId: string;
  status: CanvasTrustStatus;
  /** Fired after a successful `CANVAS_TRUST_GRANT` — the caller re-fetches trust status and opens the host. */
  onTrusted: () => void;
  /**
   * Fired when the grant was refused because the definition changed since
   * `status` was fetched (the handler's TOCTOU guard, #227 review) — the
   * caller re-fetches trust status so this prompt re-renders with the
   * current manifest/dependencies/hash instead of staying stale.
   */
  onStale: () => void;
}

/**
 * The trust prompt (#227): shown in place of running a project-tier canvas's
 * host until the user explicitly consents. Per the design doc, this never
 * blocks the UI preview — `CanvasPanel` renders this banner *alongside* the
 * (already inert, host-stopped) `CanvasFrame`, not instead of it.
 */
export function CanvasTrustPrompt({ projectId, status, onTrusted, onStale }: CanvasTrustPromptProps) {
  const ipc = useIpc();
  const [trusting, setTrusting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installOutput, setInstallOutput] = useState<string | null>(null);

  async function handleTrust() {
    setTrusting(true);
    setError(null);
    try {
      const result = await ipc.canvasTrustGrant({
        projectId,
        definition: status.definition,
        expectedContentHash: status.contentHash,
      });
      if (result.install.output) setInstallOutput(result.install.output);
      if (!result.install.ok) {
        setError('Trusted, but "bun install" failed — see the output below. You can retry from the settings hub.');
      }
      onTrusted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A "conflict" means the definition changed since `status` (and its
      // displayed contentHash) was fetched — refresh so the prompt reflects
      // what's actually on disk now instead of staying stale.
      if (err instanceof IpcError && err.code === "conflict") onStale();
    } finally {
      setTrusting(false);
    }
  }

  const { manifest, dependencies } = status;
  const permissions = manifest.permissions;
  const hasPermissions =
    !!permissions && ((permissions.fs?.length ?? 0) + (permissions.network?.length ?? 0) + (permissions.exec?.length ?? 0) > 0);

  return (
    <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs space-y-2">
      <div className="flex items-start gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {status.blockedReason
              ? "This project canvas can't be trusted"
              : status.trustedAt !== null
                ? "This project canvas changed since it was trusted"
                : "This project canvas hasn't been trusted"}
          </p>
          <p className="text-muted-foreground">
            {status.blockedReason ?? (
              <>
                <code className="text-[11px]">.agents/canvases/{status.definition}/</code> ships code from this
                project that would run with your privileges. It's shown here read-only (no tools) until you trust
                it — editing any of its files will ask again.
              </>
            )}
          </p>

          {!status.blockedReason && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <dt className="font-medium text-foreground/80">Server</dt>
              <dd>
                <code>{status.definition}/server.mjs</code>
              </dd>
              <dt className="font-medium text-foreground/80">Dependencies</dt>
              <dd>
                {!dependencies.hasPackageJson
                  ? "none"
                  : dependencies.names.length > 0
                    ? dependencies.names.join(", ")
                    : "none declared (package.json present)"}
              </dd>
              {hasPermissions && (
                <>
                  <dt className="font-medium text-foreground/80">Declares (unenforced)</dt>
                  <dd>
                    {[
                      permissions?.fs?.length ? `fs: ${permissions.fs.join(", ")}` : null,
                      permissions?.network?.length ? `network: ${permissions.network.join(", ")}` : null,
                      permissions?.exec?.length ? `exec: ${permissions.exec.join(", ")}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </dd>
                </>
              )}
            </dl>
          )}

          {error && <p className="text-destructive">{error}</p>}
          {installOutput && (
            <pre className="max-h-24 overflow-y-auto rounded bg-muted/50 p-1.5 text-[10px] whitespace-pre-wrap">
              {installOutput}
            </pre>
          )}

          {!status.blockedReason && (
            <Button size="xs" onClick={() => void handleTrust()} disabled={trusting} className="gap-1.5">
              {trusting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Trust and run
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
