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
