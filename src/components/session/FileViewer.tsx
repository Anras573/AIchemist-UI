import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";
import { useIpc } from "@/lib/ipc";

// ── Language detection ────────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rs: "rust", go: "go", java: "java",
  cs: "csharp", cpp: "cpp", cc: "cpp", cxx: "cpp", c: "c",
  rb: "ruby", php: "php", swift: "swift", kt: "kotlin",
  css: "css", scss: "scss", less: "less",
  html: "html", xml: "xml", svg: "xml",
  json: "json", jsonc: "jsonc", json5: "json5",
  md: "markdown", mdx: "mdx",
  yaml: "yaml", yml: "yaml",
  toml: "toml", sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl",
  vue: "vue", svelte: "svelte",
  r: "r", lua: "lua", ex: "elixir", exs: "elixir",
};

function detectLang(filePath: string): string {
  const filename = filePath.split("/").pop() ?? "";
  if (filename.toLowerCase() === "dockerfile") return "dockerfile";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "text";
}

// ── FileViewer ────────────────────────────────────────────────────────────────

interface FileViewerProps {
  filePath: string;
}

export function FileViewer({ filePath }: FileViewerProps) {
  const ipc = useIpc();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHtml(null);
    setError(null);

    ipc.readFile(filePath).then(async (result) => {
      if ("error" in result) {
        setError(result.error);
        return;
      }

      try {
        const highlighted = await codeToHtml(result.content, {
          lang: detectLang(filePath),
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
        });
        setHtml(highlighted);
      } catch {
        // Fall back to plain text if the language fails to load
        const escaped = result.content
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        setHtml(`<pre class="shiki-fallback"><code>${escaped}</code></pre>`);
      }
    });
  }, [filePath]);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <p className="text-sm text-muted-foreground text-center">{error}</p>
      </div>
    );
  }

  if (!html) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div
      className="file-viewer h-full overflow-auto text-xs"
      // biome-ignore lint: shiki output is trusted, generated from local files
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
