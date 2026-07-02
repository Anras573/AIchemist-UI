// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { createCodexItemSink, type NormalizedCodexItem } from "./codex-item-mapper";
import type { TurnEmitter } from "./turn-emitter";
import type { NativeTranscriptRecorder } from "../native-transcript";

function makeEmitter() {
  return {
    delta: vi.fn(),
    toolCall: vi.fn(),
    toolResult: vi.fn(),
    fileChange: vi.fn(),
  } as unknown as TurnEmitter & {
    delta: ReturnType<typeof vi.fn>;
    toolCall: ReturnType<typeof vi.fn>;
    toolResult: ReturnType<typeof vi.fn>;
    fileChange: ReturnType<typeof vi.fn>;
  };
}

function makeRecorder() {
  return {
    toolCall: vi.fn(),
    toolResult: vi.fn(),
    reasoning: vi.fn(),
  } as unknown as NativeTranscriptRecorder & {
    toolCall: ReturnType<typeof vi.fn>;
    toolResult: ReturnType<typeof vi.fn>;
    reasoning: ReturnType<typeof vi.fn>;
  };
}

const PROJECT = "/proj";

function setup() {
  const emitter = makeEmitter();
  const recorder = makeRecorder();
  const sink = createCodexItemSink({ emitter, recorder, projectPath: PROJECT });
  return { emitter, recorder, sink };
}

describe("createCodexItemSink", () => {
  it("returns agent-message text to accumulate and streams it as a delta", () => {
    const { emitter, sink } = setup();
    const text = sink.completed({ kind: "message", text: "hello" });
    expect(text).toBe("hello");
    expect(emitter.delta).toHaveBeenCalledWith("hello");
  });

  it("records reasoning to the transcript only (no timeline delta), returns empty", () => {
    const { emitter, recorder, sink } = setup();
    const text = sink.completed({ kind: "reasoning", text: "thinking..." });
    expect(text).toBe("");
    expect(recorder.reasoning).toHaveBeenCalledWith("thinking...");
    expect(emitter.delta).not.toHaveBeenCalled();
  });

  it("surfaces a tool call once across started + completed (no double-emit)", () => {
    const { emitter, recorder, sink } = setup();
    const item: NormalizedCodexItem = {
      kind: "tool",
      id: "cmd-1",
      name: "execute_bash",
      args: { command: "ls" },
      output: "total 0\n",
      isError: false,
    };
    sink.started(item);
    sink.completed(item);
    expect(emitter.toolCall).toHaveBeenCalledTimes(1);
    expect(emitter.toolCall).toHaveBeenCalledWith("cmd-1", "execute_bash", { command: "ls" });
    expect(recorder.toolCall).toHaveBeenCalledTimes(1);
    expect(emitter.toolResult).toHaveBeenCalledWith("execute_bash", "total 0\n");
    expect(recorder.toolResult).toHaveBeenCalledWith("cmd-1", "total 0\n", false);
  });

  it("surfaces the call even when a fast item completes without a prior started", () => {
    const { emitter, sink } = setup();
    sink.completed({
      kind: "tool",
      id: "cmd-2",
      name: "execute_bash",
      args: {},
      output: "",
      isError: false,
    });
    expect(emitter.toolCall).toHaveBeenCalledTimes(1);
    expect(emitter.toolResult).toHaveBeenCalledTimes(1);
  });

  it("marks a failed tool result as an error in the transcript", () => {
    const { recorder, sink } = setup();
    sink.completed({
      kind: "tool",
      id: "cmd-3",
      name: "execute_bash",
      args: {},
      output: "boom",
      isError: true,
    });
    expect(recorder.toolResult).toHaveBeenCalledWith("cmd-3", "boom", true);
  });

  it("drives the Changes panel from a successful file_change item", () => {
    const { emitter, sink } = setup();
    sink.completed({
      kind: "tool",
      id: "fc-1",
      name: "file_change",
      args: {},
      output: "",
      isError: false,
      fileChanges: [
        { path: "src/a.ts", operation: "write" },
        { path: "src/b.ts", operation: "delete" },
      ],
    });
    expect(emitter.fileChange).toHaveBeenCalledTimes(2);
    expect(emitter.fileChange).toHaveBeenNthCalledWith(1, {
      path: "/proj/src/a.ts",
      relativePath: "src/a.ts",
      diff: "",
      operation: "write",
    });
    expect(emitter.fileChange).toHaveBeenNthCalledWith(2, {
      path: "/proj/src/b.ts",
      relativePath: "src/b.ts",
      diff: "",
      operation: "delete",
    });
  });

  it("does not drive the Changes panel for a failed file_change item", () => {
    const { emitter, sink } = setup();
    sink.completed({
      kind: "tool",
      id: "fc-2",
      name: "file_change",
      args: {},
      output: "",
      isError: true,
      fileChanges: [{ path: "src/a.ts", operation: "write" }],
    });
    expect(emitter.fileChange).not.toHaveBeenCalled();
  });

  it("skips file changes that escape the workspace or live in ignored dirs", () => {
    const { emitter, sink } = setup();
    sink.completed({
      kind: "tool",
      id: "fc-3",
      name: "file_change",
      args: {},
      output: "",
      isError: false,
      fileChanges: [
        { path: "../outside.ts", operation: "write" },
        { path: "node_modules/pkg/index.js", operation: "write" },
        { path: ".git/config", operation: "write" },
        { path: "src/keep.ts", operation: "write" },
      ],
    });
    expect(emitter.fileChange).toHaveBeenCalledTimes(1);
    expect(emitter.fileChange).toHaveBeenCalledWith({
      path: "/proj/src/keep.ts",
      relativePath: "src/keep.ts",
      diff: "",
      operation: "write",
    });
  });

  it("ignores unrecognized items", () => {
    const { emitter, recorder, sink } = setup();
    expect(sink.started({ kind: "ignored" })).toBeUndefined();
    expect(sink.completed({ kind: "ignored" })).toBe("");
    expect(emitter.toolCall).not.toHaveBeenCalled();
    expect(emitter.delta).not.toHaveBeenCalled();
    expect(recorder.toolCall).not.toHaveBeenCalled();
  });

  it("works without a recorder (null)", () => {
    const emitter = makeEmitter();
    const sink = createCodexItemSink({ emitter, recorder: null, projectPath: PROJECT });
    expect(() =>
      sink.completed({ kind: "tool", id: "x", name: "web_search", args: {}, output: "q", isError: false }),
    ).not.toThrow();
    expect(emitter.toolResult).toHaveBeenCalledWith("web_search", "q");
  });
});
