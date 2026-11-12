import { memo, useMemo } from "react";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockLine,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/lib/hooks/useHighlightedCode";
import type { DiffRow, DiffRowKind } from "@/lib/parseUnifiedDiff";
import { cn } from "@/lib/utils";

const LINE_VARIANT: Record<
  DiffRowKind,
  "default" | "added" | "removed" | "highlighted"
> = {
  meta: "default",
  hunk: "highlighted",
  added: "added",
  removed: "removed",
  context: "default",
};

interface DiffBlockProps {
  rows: DiffRow[];
  /** Language of the file being diffed (see `languageForPath`); "text" = no highlighting. */
  language?: string;
  className?: string;
}

/**
 * A unified diff rendered with shadcn's `CodeBlock`: added/removed rows get the
 * `+` / `−` marker and tint from `CodeBlockLine`'s variants, hunk headers are
 * highlighted, and file headers are muted. The code itself is syntax-highlighted
 * as a single stream (same trade-off as shadcn's own diff example: grammar state
 * runs across hunks, so a block comment opened in one hunk can bleed into the next).
 */
export const DiffBlock = memo(function DiffBlock({
  rows,
  language = "text",
  className,
}: DiffBlockProps) {
  // One entry per row so the highlighter's line N is row N. Header rows aren't
  // code, so they contribute an empty line and are rendered from their raw text.
  const source = useMemo(
    () =>
      rows
        .map((row) => (row.kind === "meta" || row.kind === "hunk" ? "" : row.text))
        .join("\n"),
    [rows]
  );
  const lines = useHighlightedCode(source, language);

  return (
    <CodeBlock size="sm" className={cn("rounded-none border-0", className)}>
      <CodeBlockContent>
        {rows.map((row, index) => (
          <CodeBlockLine key={index} variant={LINE_VARIANT[row.kind]}>
            {row.kind === "meta" || row.kind === "hunk" ? (
              <span className="text-muted-foreground">{row.text}</span>
            ) : (
              (lines[index] ?? row.text)
            )}
          </CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
});
