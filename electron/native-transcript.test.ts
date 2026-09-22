// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setNativeTracesRootForTests,
  createNativeTranscriptReader,
  createNativeTranscriptRecorder,
  createNativeSpanAccumulator,
  findNativeTranscriptFile,
  nativeEventsToSpans,
  nativeTranscriptPath,
  parseNativeTranscript,
  watchNativeTranscript,
  type NativeEvent,
} from "./native-transcript";
import type { TraceSpan } from "../src/types/index";

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

describe("createNativeTranscriptReader", () => {
  it("only parses appended bytes across reads, returning the full accumulated list", async () => {
    const file = nativeTranscriptPath("sess-inc");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (e: NativeEvent) => JSON.stringify(e) + "\n";

    fs.writeFileSync(file, line({ type: "turn_start", ts: 1, turnId: "t", provider: "ollama" }));
    const reader = createNativeTranscriptReader(file);
    let events = await reader.readAll();
    expect(events).toHaveLength(1);

    // Append more — the reader should pick up only the new lines but still
    // return the full accumulated list.
    fs.appendFileSync(
      file,
      line({ type: "tool_call", ts: 2, turnId: "t", toolCallId: "c1", name: "read_file", input: {} }) +
        line({ type: "turn_end", ts: 3, turnId: "t", status: "success" }),
    );
    events = await reader.readAll();
    expect(events.map((e) => e.type)).toEqual(["turn_start", "tool_call", "turn_end"]);

    // No change — no new events, list unchanged.
    events = await reader.readAll();
    expect(events).toHaveLength(3);
  });

  it("buffers a partial trailing line until it is completed", async () => {
    const file = nativeTranscriptPath("sess-partial");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write a complete line plus the start of a second (no trailing newline).
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "turn_start", ts: 1, turnId: "t", provider: "ollama" }) +
        '\n{"type":"turn_end","ts":2,',
    );
    const reader = createNativeTranscriptReader(file);
    expect(await reader.readAll()).toHaveLength(1);

    // Complete the partial line — it should now parse.
    fs.appendFileSync(file, '"turnId":"t","status":"success"}\n');
    const events = await reader.readAll();
    expect(events.map((e) => e.type)).toEqual(["turn_start", "turn_end"]);
  });

  it("readIncremental returns only the newly-appended events, with didReset on truncation", async () => {
    const file = nativeTranscriptPath("sess-inc2");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (e: NativeEvent) => JSON.stringify(e) + "\n";

    fs.writeFileSync(file, line({ type: "turn_start", ts: 1, turnId: "t", provider: "ollama" }));
    const reader = createNativeTranscriptReader(file);
    let res = await reader.readIncremental();
    expect(res.newEntries.map((e) => e.type)).toEqual(["turn_start"]);
    expect(res.didReset).toBe(false);

    fs.appendFileSync(file, line({ type: "turn_end", ts: 2, turnId: "t", status: "success" }));
    res = await reader.readIncremental();
    expect(res.newEntries.map((e) => e.type)).toEqual(["turn_end"]);

    // Nothing new — empty, no reset.
    res = await reader.readIncremental();
    expect(res.newEntries).toEqual([]);
    expect(res.didReset).toBe(false);

    // File shrinks (rotate/truncate) — reset flagged, new content returned.
    fs.writeFileSync(file, line({ type: "turn_start", ts: 3, turnId: "t2", provider: "ollama" }));
    res = await reader.readIncremental();
    expect(res.didReset).toBe(true);
    expect(res.newEntries.map((e) => e.type)).toEqual(["turn_start"]);
  });
});

describe("createNativeSpanAccumulator (incremental)", () => {
  it("feeding events one at a time matches a single full parse", () => {
    const events: NativeEvent[] = [
      { type: "turn_start", ts: 1000, turnId: "t1", provider: "ollama", model: "m" },
      { type: "tool_call", ts: 1100, turnId: "t1", toolCallId: "c1", name: "read_file", input: {} },
      { type: "tool_result", ts: 1200, turnId: "t1", toolCallId: "c1", isError: false, output: "ok" },
      { type: "usage", ts: 1300, turnId: "t1", input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      { type: "turn_end", ts: 1400, turnId: "t1", status: "success" },
    ];

    const full = nativeEventsToSpans(events, { sessionId: "s" });

    const acc = createNativeSpanAccumulator({ sessionId: "s" });
    let incremental: TraceSpan[] = [];
    for (const e of events) incremental = acc.applyEvents([e]);

    expect(incremental).toEqual(full);
  });

  it("only rebuilds the turn touched by the latest batch, leaving other turns' span objects untouched", () => {
    const acc = createNativeSpanAccumulator({ sessionId: "s" });

    acc.applyEvents([
      { type: "turn_start", ts: 1, turnId: "t1", provider: "ollama" },
      { type: "turn_end", ts: 2, turnId: "t1", status: "success" },
    ]);
    const afterT1 = acc.applyEvents([{ type: "turn_start", ts: 3, turnId: "t2", provider: "ollama" }]);
    const t1SpanRef = afterT1.find((s) => s.id === "turn:native:s:t1")!;
    expect(t1SpanRef.status).toBe("success");

    const afterT2 = acc.applyEvents([{ type: "turn_end", ts: 4, turnId: "t2", status: "success" }]);

    // t1's span wasn't touched by the batch that only affected t2.
    expect(afterT2.find((s) => s.id === "turn:native:s:t1")).toBe(t1SpanRef);
    expect(afterT2.find((s) => s.id === "turn:native:s:t2")!.status).toBe("success");
  });
});

describe("watchNativeTranscript", () => {
  it("emits updated spans as events are appended, without re-parsing already-seen events", async () => {
    const sessionId = "sess-watch";
    const updates: TraceSpan[][] = [];
    const watcher = watchNativeTranscript(sessionId, { onUpdate: (spans) => updates.push(spans) });

    try {
      const rec = createNativeTranscriptRecorder(sessionId, "ollama");
      rec.turnStart("m");
      rec.toolCall("c1", "read_file", {});
      rec.toolResult("c1", "ok", false);
      rec.turnEnd("success");

      // Poll until the watcher's 100ms debounce + fs event catches up.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const last = updates[updates.length - 1];
        if (last?.find((s) => s.type === "turn")?.status === "success") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const last = updates[updates.length - 1];
      expect(last).toBeDefined();
      const turn = last!.find((s) => s.type === "turn")!;
      expect(turn.status).toBe("success");
      const tool = last!.find((s) => s.type === "tool")!;
      expect(tool.status).toBe("success");
    } finally {
      watcher.close();
    }
  });
});
