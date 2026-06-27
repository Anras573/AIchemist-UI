import { Check, AlertCircle, Loader2, Slash } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { WithTooltip } from "@/components/ui/with-tooltip";
import type { ProviderProbeResult } from "@/types";

type Tone = "ok" | "warn" | "error" | "muted";

interface Summary {
  label: string;
  tone: Tone;
}

/**
 * Collapse a probe result into a short status label. The full reason is shown
 * in the badge tooltip, so the label only needs to convey the gist. Heuristics
 * over the reason text mirror the categories the backend probes emit
 * (electron/agent/provider-probe.ts and each provider's own probe()).
 */
export function summarizeProbe(result: ProviderProbeResult): Summary {
  if (result.ok) return { label: "Connected", tone: "ok" };

  const reason = (result.reason ?? "").toLowerCase();
  if (reason.includes("disabled in settings")) return { label: "Disabled", tone: "muted" };
  if (reason.includes("invalid") || reason.includes("unauthor") || reason.includes("401") || reason.includes("403")) {
    return { label: "Invalid key", tone: "error" };
  }
  if (reason.includes("base url") || reason.includes("base_url")) {
    return { label: "Check base URL", tone: "warn" };
  }
  if (reason.includes("not set") || reason.includes("not configured") || reason.includes("no endpoints")) {
    return { label: "Not configured", tone: "warn" };
  }
  if (
    reason.includes("not running") ||
    reason.includes("no models") ||
    reason.includes("econn") ||
    reason.includes("fetch failed") ||
    reason.includes("timed out") ||
    reason.includes("timeout")
  ) {
    return { label: "Not running", tone: "warn" };
  }
  return { label: "Unavailable", tone: "error" };
}

const TONE_VARIANT = {
  ok: "secondary",
  warn: "outline",
  error: "destructive",
  muted: "outline",
} as const;

// Inline status icons are sized explicitly (the shared Badge also constrains
// direct-child svgs) to keep badge content from jittering or oversizing.
const ICON = "h-3 w-3";

function ToneIcon({ tone }: { tone: Tone }) {
  if (tone === "ok") return <Check aria-hidden className={`${ICON} text-green-600`} />;
  if (tone === "muted") return <Slash aria-hidden className={`${ICON} text-muted-foreground`} />;
  return <AlertCircle aria-hidden className={ICON} />;
}

interface ProbeBadgeProps {
  /** The probe result for this provider/endpoint, or `undefined` while loading. */
  result: ProviderProbeResult | undefined;
  /** True while a probe round is in flight (greys nothing out, just shows a spinner). */
  checking?: boolean;
}

/**
 * Live connectivity badge for a provider card. Reads a single probe result
 * (from `useProviderProbes`) and renders ✓ Connected / Invalid key / Check base
 * URL / Not running / Disabled, with the full reason in a hover tooltip.
 */
export function ProbeBadge({ result, checking }: ProbeBadgeProps) {
  if (!result) {
    // A missing result means either a probe is in flight (`checking`) or there's
    // genuinely no entry for this provider (e.g. a probe map mismatch). Only the
    // former is a loading state; otherwise fall back to a deterministic
    // "Unavailable" so the badge can't get stuck on a permanent spinner.
    if (checking) {
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground" aria-label="Status: Checking">
          <Loader2 aria-hidden className={`${ICON} animate-spin`} />
          Checking…
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground" aria-label="Status: Unavailable">
        <AlertCircle aria-hidden className={ICON} />
        Unavailable
      </Badge>
    );
  }

  const { label, tone } = summarizeProbe(result);
  const badge = (
    <Badge
      variant={TONE_VARIANT[tone]}
      className={tone === "ok" ? "gap-1 text-green-700 dark:text-green-500" : "gap-1"}
      aria-label={`Status: ${label}`}
    >
      {checking ? <Loader2 aria-hidden className={`${ICON} animate-spin`} /> : <ToneIcon tone={tone} />}
      {label}
    </Badge>
  );

  // Only wrap in a tooltip when there's a reason worth surfacing.
  if (result.ok || !result.reason) return badge;
  return (
    <WithTooltip label={result.reason} side="top">
      {badge}
    </WithTooltip>
  );
}
