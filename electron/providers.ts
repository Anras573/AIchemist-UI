/** Canonical provider ID list. Extend here when adding a new provider. */
export const PROVIDER_IDS = ["anthropic", "copilot", "acp"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Human-readable labels for display in the UI. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic (Claude)",
  copilot: "GitHub Copilot",
  acp: "ACP",
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Parse the comma-separated `AICHEMIST_DISABLED_PROVIDERS` value into a Set.
 * Invalid / unknown tokens are silently ignored.
 */
export function parseDisabledProviders(raw: string | undefined): Set<ProviderId> {
  const out = new Set<ProviderId>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const v = part.trim().toLowerCase();
    if (isProviderId(v)) out.add(v);
  }
  return out;
}

/**
 * Serialize a disabled-providers Set back to the canonical comma-separated
 * string (preserves the canonical ordering defined in PROVIDER_IDS).
 */
export function serializeDisabledProviders(set: Set<ProviderId>): string {
  return PROVIDER_IDS.filter((p) => set.has(p)).join(",");
}
