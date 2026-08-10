import { useEffect, useState } from "react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import type { PluginConfig, MathPlugin, DiagramPlugin } from "streamdown";

/** Always-eager Streamdown plugins — lightweight, needed for basic formatting and code blocks. */
export const baseStreamdownPlugins: PluginConfig = { cjk, code };

type HeavyPlugins = { math: MathPlugin; mermaid: DiagramPlugin };

let heavyPluginsPromise: Promise<HeavyPlugins> | null = null;

function loadHeavyStreamdownPlugins(): Promise<HeavyPlugins> {
  if (!heavyPluginsPromise) {
    heavyPluginsPromise = Promise.all([
      import("@streamdown/math").then((m) => m.math),
      import("@streamdown/mermaid").then((m) => m.mermaid),
    ]).then(([math, mermaid]) => ({ math, mermaid }));
  }
  return heavyPluginsPromise;
}

/**
 * The mermaid (mermaid.js) and math (KaTeX) Streamdown plugins are large and
 * most messages use neither, so they're fetched as a separate chunk on first
 * render instead of being bundled into the initial app load (issue #181).
 * The shared in-flight promise means every Streamdown consumer in the app
 * triggers at most one fetch, however many render at once.
 */
export function useStreamdownPlugins(): PluginConfig {
  const [heavy, setHeavy] = useState<HeavyPlugins | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadHeavyStreamdownPlugins().then((loaded) => {
      if (!cancelled) setHeavy(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return heavy ? { ...baseStreamdownPlugins, ...heavy } : baseStreamdownPlugins;
}
