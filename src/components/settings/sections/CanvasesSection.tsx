import { useState } from "react";
import { AlertCircle, Loader2, ShieldCheck } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useIpcQuery } from "@/lib/hooks/useIpcQuery";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CanvasDefinitionTier, CanvasDiscoveryResult, CanvasTrustStatus } from "@/types";

// ── Tier badge ───────────────────────────────────────────────────────────────

const TIER_LABEL: Record<CanvasDefinitionTier, { label: string; className: string }> = {
  project: { label: "project", className: "text-blue-500" },
  global: { label: "global", className: "text-purple-500" },
  builtin: { label: "built-in", className: "text-emerald-500" },
};

function TierBadge({ tier }: { tier: CanvasDefinitionTier }) {
  const meta = TIER_LABEL[tier];
  return <span className={cn("text-[10px] font-medium shrink-0", meta.className)}>{meta.label}</span>;
}

// ── Trust (#227) ─────────────────────────────────────────────────────────────

/**
 * Trust status + revoke action for one project-tier definition. A separate
 * component (rather than inlining the query in the list) so each row's
 * `CANVAS_TRUST_STATUS` fetch is independently keyed/cached and a revoke only
 * re-renders its own row.
 */
function ProjectCanvasTrust({ projectId, definition }: { projectId: string; definition: string }) {
  const ipc = useIpc();
  const [revoking, setRevoking] = useState(false);
  const key = `hub-canvas-trust:${projectId}:${definition}`;
  const { data: status, refetch } = useIpcQuery<CanvasTrustStatus | null>(
    key,
    () => ipc.canvasTrustStatus({ projectId, definition }),
    { ttl: 10_000 }
  );

  if (status === undefined) {
    return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
  }
  // Not a valid project definition (manifest missing/invalid) — the listing
  // above already surfaces that as a manifest error; nothing to show here.
  if (status === null) return null;

  if (!status.trusted) {
    return <span className="text-[10px] font-medium shrink-0 text-amber-500">not trusted</span>;
  }

  async function handleRevoke() {
    setRevoking(true);
    try {
      await ipc.canvasTrustRevoke({ projectId, definition });
      await refetch();
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="h-3 w-3" />
        trusted
      </span>
      <Button size="xs" variant="ghost" onClick={() => void handleRevoke()} disabled={revoking}>
        {revoking ? <Loader2 className="h-3 w-3 animate-spin" /> : "Revoke"}
      </Button>
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface CanvasesSectionProps {
  /** Active project id. Empty when the hub is opened standalone — the project tier is then simply not scanned. */
  projectId: string;
}

// ── Section ───────────────────────────────────────────────────────────────────

/**
 * Read-only listing of discovered canvas definitions (#226) — project /
 * global / built-in tiers, with same-name suppression already applied by
 * `discoverCanvasDefinitions`, plus any manifest that failed to read or
 * validate. Unlike Skills/Agents there's no create/edit affordance here yet:
 * authoring a canvas from the hub is a later phase (see the design doc).
 */
export function CanvasesSection({ projectId }: CanvasesSectionProps) {
  const ipc = useIpc();

  const key = `hub-canvases:${projectId}`;
  const { data, error } = useIpcQuery<CanvasDiscoveryResult>(key, () =>
    ipc.canvasListDefinitions({ projectId: projectId || undefined }),
  );

  return (
    <div className="space-y-3">
      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {String(error)}
        </div>
      ) : data === undefined ? (
        <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading canvases…
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {data.definitions.length === 0 ? (
              <div className="px-2 py-6 text-sm text-muted-foreground">
                No canvas definitions found. Add one under{" "}
                <code className="text-xs">~/.aichemist/canvases/&lt;name&gt;/</code> (or a project's{" "}
                <code className="text-xs">.agents/canvases/&lt;name&gt;/</code>).
              </div>
            ) : (
              data.definitions.map((d) => (
                <div
                  key={`${d.tier}:${d.id}`}
                  className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2.5"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{d.manifest.name}</span>
                      <TierBadge tier={d.tier} />
                      {d.tier === "project" && projectId && (
                        <ProjectCanvasTrust projectId={projectId} definition={d.id} />
                      )}
                    </div>
                    {d.manifest.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
                        {d.manifest.description}
                      </p>
                    )}
                    <p className="text-[10px] text-muted-foreground/70 mt-1 truncate" title={d.path}>
                      {d.path}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>

          {data.errors.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Manifest errors</p>
              {data.errors.map((e) => (
                <div
                  key={`${e.tier}:${e.id}`}
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
                >
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-destructive" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{e.id}</span>
                      <TierBadge tier={e.tier} />
                    </div>
                    <p className="text-muted-foreground mt-0.5">{e.reason}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
