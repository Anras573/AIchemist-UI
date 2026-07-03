import * as nodePath from "node:path";
import type { TurnEmitter } from "./turn-emitter";
import type { NativeTranscriptRecorder } from "../native-transcript";

// ─────────────────────────────────────────────────────────────────────────────
// Shared Codex item mapper.
//
// Codex has two transports: the `codex exec` SDK path (`@openai/codex-sdk`
// ThreadItem events) and the `codex app-server` JSON-RPC path (streamed
// `item/*` notifications). Their raw item shapes differ, but both carry the same
// logical items (agent message, reasoning, command execution, file change, MCP
// tool call, web search). Each transport adapts its raw items to the
// transport-agnostic {@link NormalizedCodexItem} shape, and this module owns the
// single reflection path onto the TurnEmitter + native transcript — so the two
// transports render identically on the timeline and in traces.
// ─────────────────────────────────────────────────────────────────────────────

/** A file edit surfaced by a Codex `file_change` item, normalized across transports. */
export interface CodexFileChange {
  path: string;
  operation: "write" | "delete";
}

/**
 * A Codex turn item normalized to a transport-agnostic shape. The exec (SDK
 * `ThreadItem`) and app-server (`item/*`) transports each adapt their raw items
 * to this union so the emit logic in {@link createCodexItemSink} is shared.
 */
export type NormalizedCodexItem =
  | { kind: "message"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      output: string;
      isError: boolean;
      /** Present on file_change items; drives the Changes panel on successful completion. */
      fileChanges?: CodexFileChange[];
    }
  | { kind: "ignored" };

export interface CodexItemSinkDeps {
  emitter: TurnEmitter;
  recorder: NativeTranscriptRecorder | null;
  projectPath: string;
}

// ── App-server item adapter ────────────────────────────────────────────────────
//
// The `codex app-server` transport streams items with camelCase discriminators
// and slightly different field names than the exec SDK's snake_case ThreadItem
// (e.g. `commandExecution` vs `command_execution`, `aggregatedOutput` vs
// `aggregated_output`). This adapter maps those raw payloads (typed `unknown`
// because the client passes them through) onto the shared NormalizedCodexItem so
// both transports feed the same sink. Shapes per codex-rs/app-server/README.md.
// The exec adapter (`fromSdkThreadItem`) lives in codex.ts since it needs the SDK
// type; this one is pure `unknown`-parsing, so it lives here with the sink.

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Adapt a raw app-server `item/*` payload to a {@link NormalizedCodexItem}. */
export function fromAppServerItem(raw: unknown): NormalizedCodexItem {
  const item = (raw ?? {}) as Record<string, unknown>;
  const id = str(item.id);
  const isError = item.status === "failed";
  switch (item.type) {
    case "agentMessage":
      return { kind: "message", text: str(item.text) };
    case "reasoning":
      // App-server splits reasoning into a summary + raw content; prefer content.
      return { kind: "reasoning", text: str(item.content) || str(item.summary) };
    case "commandExecution":
      return {
        kind: "tool",
        id,
        name: "execute_bash",
        args: { command: str(item.command) },
        output: str(item.aggregatedOutput),
        isError,
      };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
      return {
        kind: "tool",
        id,
        name: "file_change",
        args: { changes },
        output: changes.map((c) => `${str(c.kind)} ${str(c.path)}`).join("\n"),
        isError,
        fileChanges: changes.map((c) => ({
          path: str(c.path),
          operation: c.kind === "delete" ? "delete" : "write",
        })),
      };
    }
    case "mcpToolCall":
      return {
        kind: "tool",
        id,
        name: `${str(item.server)}.${str(item.tool)}`,
        args: (item.arguments ?? {}) as Record<string, unknown>,
        output: renderAppServerMcpResult(item),
        isError: isError || item.error != null,
      };
    case "webSearch":
      return { kind: "tool", id, name: "web_search", args: { query: str(item.query) }, output: str(item.query), isError: false };
    default:
      return { kind: "ignored" };
  }
}

/** Render an app-server mcpToolCall result/error as readable text (string preferred). */
function renderAppServerMcpResult(item: Record<string, unknown>): string {
  const err = item.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  const result = item.result;
  if (typeof result === "string") return result;
  return result === undefined || result === null ? "" : JSON.stringify(result);
}

/** The noisiest dirs to keep out of the Changes panel (a subset of the fs-handlers ignore list). */
const IGNORED_CHANGE_DIRS = new Set([".git", "node_modules"]);

/**
 * Build the shared reflector for one turn's normalized items. It owns the
 * started/completed tool-call dedup and drives the TurnEmitter + native
 * transcript identically for every Codex transport. Stateful only in the
 * per-turn `startedToolIds` set.
 */
export function createCodexItemSink(deps: CodexItemSinkDeps) {
  const { emitter, recorder, projectPath } = deps;
  // Codex tool items carry an `item.started`/`item.completed` pair; track which
  // ids we've surfaced a tool-call for so we don't double-emit.
  const startedToolIds = new Set<string>();

  const surfaceToolCall = (item: Extract<NormalizedCodexItem, { kind: "tool" }>): void => {
    if (startedToolIds.has(item.id)) return;
    startedToolIds.add(item.id);
    emitter.toolCall(item.id, item.name, item.args);
    recorder?.toolCall(item.id, item.name, item.args);
  };

  return {
    /** Reflect an item that just started (a tool call becomes visible immediately). */
    started(item: NormalizedCodexItem): void {
      if (item.kind === "tool") surfaceToolCall(item);
    },
    /**
     * Reflect a completed item. Returns any agent-message text to accumulate into
     * the turn's full text (`""` for non-message items).
     */
    completed(item: NormalizedCodexItem): string {
      switch (item.kind) {
        case "message":
          emitter.delta(item.text);
          return item.text;
        case "reasoning":
          recorder?.reasoning(item.text);
          return "";
        case "tool":
          // Ensure the call was surfaced (a fast item may complete without a
          // separate `started`), then reflect its result.
          surfaceToolCall(item);
          emitter.toolResult(item.name, item.output);
          recorder?.toolResult(item.id, item.output, item.isError);
          // A successful patch also drives the Changes panel (parity with the
          // other providers).
          if (item.fileChanges && !item.isError) {
            emitFileChanges(emitter, projectPath, item.fileChanges);
          }
          return "";
        default:
          return "";
      }
    },
  };
}

/**
 * Drive the renderer's Changes panel (SESSION_FILE_CHANGE) from normalized file
 * changes. Best-effort: Codex doesn't give us a diff, and a path we can't
 * resolve (or that escapes the workspace / lives in an ignored dir) is skipped
 * rather than breaking the turn.
 */
function emitFileChanges(emitter: TurnEmitter, projectPath: string, changes: CodexFileChange[]): void {
  for (const change of changes) {
    try {
      const abs = nodePath.isAbsolute(change.path)
        ? nodePath.normalize(change.path)
        : nodePath.resolve(projectPath, change.path);
      const rel = nodePath.relative(projectPath, abs);
      // Only reflect in-project edits: skip paths that escape the workspace, and
      // skip the dirs the fs tooling already ignores so the panel stays signal.
      if (!rel || rel.startsWith("..") || nodePath.isAbsolute(rel)) continue;
      if (rel.split(nodePath.sep).some((seg) => IGNORED_CHANGE_DIRS.has(seg))) continue;
      emitter.fileChange({ path: abs, relativePath: rel, diff: "", operation: change.operation });
    } catch {
      // best-effort — never break the turn on an unresolvable path
    }
  }
}
