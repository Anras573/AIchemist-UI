/**
 * Maps a file path to a language `loadHighlighter()` (src/lib/highlighter.tsx)
 * can highlight. Anything unlisted returns "text", which renders unhighlighted.
 */
const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
};

export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "text"; // no extension, or a dotfile like ".env"
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "text";
}
