import { AlertCircle, Loader2 } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useIpcQuery } from "@/lib/hooks/useIpcQuery";
import { cn } from "@/lib/utils";
import type { CanvasDefinitionTier, CanvasDiscoveryResult } from "@/types";

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
                      {d.tier === "project" && (
                        <span className="text-[10px] font-medium shrink-0 text-amber-500">
                          not runnable yet
                        </span>
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
