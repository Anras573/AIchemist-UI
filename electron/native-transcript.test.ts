// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setNativeTracesRootForTests,
  createNativeTranscriptRecorder,
  findNativeTranscriptFile,
  nativeEventsToSpans,
  nativeTranscriptPath,
  parseNativeTranscript,
  type NativeEvent,
} from "./native-transcript";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "native-transcript-"));
  _setNativeTracesRootForTests(root);
});

afterEach(() => {
  _setNativeTracesRootForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createNativeTranscriptRecorder", () => {
  it("writes a turn with tool spans that round-trips through the parser", async () => {
    const rec = createNativeTranscriptRecorder("sess-1", "ollama");
    rec.turnStart("llama3.2");
    rec.toolCall("tc-1", "write_file", { path: "a.ts", content: "x" });
    rec.toolResult("tc-1", "wrote a.ts", false);
    rec.toolCall("tc-2", "execute_bash", { command: "ls" });
    rec.toolResult("tc-2", "boom", true);
    rec.usage({ input: 10, output: 20, cacheRead: 1, cacheCreation: 2 });
    rec.turnEnd("success");

    const file = findNativeTranscriptFile("sess-1");
    expect(file).toBe(nativeTranscriptPath("sess-1"));

    const events = await parseNativeTranscript(file!);
    const spans = nativeEventsToSpans(events, { sessionId: "sess-1" });

    const turn = spans.find((s) => s.type === "turn")!;
    expect(turn.status).toBe("success");
    expect(turn.name).toBe("Agent Turn");
    expect(turn.id).toMatch(/^turn:native:sess-1:/);
    expect(turn.meta?.model).toBe("llama3.2");
    expect(turn.meta?.tokens).toEqual({ input: 10, output: 20, cacheRead: 1, cacheCreation: 2 });

    const tools = spans.filter((s) => s.type === "tool");
    expect(tools.map((t) => t.name)).toEqual(["write_file", "execute_bash"]);
    expect(tools.every((t) => t.parentId === turn.id)).toBe(true);
    expect(tools[0].status).toBe("success");
    expect(tools[1].status).toBe("error");
    expect((tools[1].meta?.toolResult as { isError: boolean }).isError).toBe(true);
  });

  it("folds streamed reasoning into a single turn-level thinking blob", async () => {
    const rec = createNativeTranscriptRecorder("sess-2", "openai-compatible");
    rec.turnStart("gpt-x");
    rec.reasoning("Let me ");
    rec.reasoning("think.");
    rec.turnEnd("success");

    const events = await parseNativeTranscript(findNativeTranscriptFile("sess-2")!);
    const reasoningEvents = events.filter((e) => e.type === "reasoning");
    expect(reasoningEvents).toHaveLength(1);

    const turn = nativeEventsToSpans(events, { sessionId: "sess-2" }).find((s) => s.type === "turn")!;
    expect(turn.meta?.thinking).toBe("Let me think.");
  });

  it("turnEnd is idempotent — a second call writes nothing", async () => {
    const rec = createNativeTranscriptRecorder("sess-3", "ollama");
    rec.turnStart();
    rec.turnEnd("error");
    rec.turnEnd("success");

    const events = await parseNativeTranscript(findNativeTranscriptFile("sess-3")!);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({ status: "error" });
  });

  it("appends multiple turns to the same session file", async () => {
    const first = createNativeTranscriptRecorder("sess-4", "ollama");
    first.turnStart("m");
    first.turnEnd("success");
    const second = createNativeTranscriptRecorder("sess-4", "ollama");
    second.turnStart("m");
    second.turnEnd("success");

    const events = await parseNativeTranscript(findNativeTranscriptFile("sess-4")!);
    const spans = nativeEventsToSpans(events, { sessionId: "sess-4" });
    expect(spans.filter((s) => s.type === "turn")).toHaveLength(2);
  });
});

describe("nativeEventsToSpans", () => {
  it("marks an unfinished turn as running with no end time", () => {
    const events: NativeEvent[] = [
      { type: "turn_start", ts: 1000, turnId: "t1", provider: "ollama", model: "m" },
      { type: "tool_call", ts: 1100, turnId: "t1", toolCallId: "c1", name: "read_file", input: {} },
    ];
    const spans = nativeEventsToSpans(events, { sessionId: "s" });
    const turn = spans.find((s) => s.type === "turn")!;
    expect(turn.status).toBe("running");
    expect(turn.endMs).toBeUndefined();
    const tool = spans.find((s) => s.type === "tool")!;
    expect(tool.status).toBe("running");
    expect(tool.endMs).toBeUndefined();
  });

  it("skips malformed lines", async () => {
    const file = nativeTranscriptPath("sess-bad");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "turn_start", ts: 1, turnId: "t", provider: "ollama" }),
        "{ not json",
        JSON.stringify({ type: "turn_end", ts: 2, turnId: "t", status: "success" }),
      ].join("\n") + "\n",
    );
    const events = await parseNativeTranscript(file);
    expect(events).toHaveLength(2);
  });

  it("returns no source file before any turn is recorded", () => {
    expect(findNativeTranscriptFile("never-ran")).toBeNull();
  });
});
