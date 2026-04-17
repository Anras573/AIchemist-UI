// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("os", () => ({
  default: { homedir: () => "/home/user" },
  homedir: () => "/home/user",
}));

type FakeFs = Record<string, string>;
const files: FakeFs = {};
const dirs = new Set<string>();

vi.mock("fs/promises", () => {
  const ENOENT = (p: string) => {
    const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    e.code = "ENOENT";
    return e;
  };
  return {
    default: {},
    stat: async (p: string) => {
      if (p in files) {
        return { size: Buffer.byteLength(files[p], "utf8"), isDirectory: () => false, mtimeMs: 1 };
      }
      if (dirs.has(p)) return { size: 0, isDirectory: () => true, mtimeMs: 1 };
      throw ENOENT(p);
    },
    readFile: async (p: string) => {
      if (!(p in files)) throw ENOENT(p);
      return files[p];
    },
    access: async (p: string) => {
      if (!(p in files) && !dirs.has(p)) throw ENOENT(p);
    },
    open: async (p: string) => {
      if (!(p in files)) throw ENOENT(p);
      const content = Buffer.from(files[p], "utf8");
      return {
        read: async (buf: Buffer, bufOff: number, len: number, pos: number) => {
          const slice = content.subarray(pos, pos + len);
          slice.copy(buf, bufOff);
          return { bytesRead: slice.length, buffer: buf };
        },
        close: async () => {},
      };
    },
  };
});

vi.mock("fs", () => ({
  default: {},
  watch: () => ({ close() {} }),
}));

import {
  copilotEventsPath,
  findCopilotEventsFile,
  parseCopilotEvents,
  createCopilotEventsReader,
  copilotEventsToSpans,
  type CopilotEvent,
} from "./copilot-transcript";

const SID = "abc123";
const EV_PATH = "/home/user/.copilot/session-state/abc123/events.jsonl";

beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k];
  dirs.clear();
  dirs.add("/home/user/.copilot/session-state");
  dirs.add("/home/user/.copilot/session-state/abc123");
});

function jsonl(events: CopilotEvent[]) {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("copilot-transcript paths", () => {
  it("computes the expected events.jsonl path", () => {
    expect(copilotEventsPath(SID)).toBe(EV_PATH);
  });

  it("findCopilotEventsFile returns null when missing", async () => {
    expect(await findCopilotEventsFile(SID)).toBeNull();
  });

  it("findCopilotEventsFile returns the path when present", async () => {
    files[EV_PATH] = "";
    expect(await findCopilotEventsFile(SID)).toBe(EV_PATH);
  });
});

describe("parseCopilotEvents", () => {
  it("returns [] when file missing", async () => {
    expect(await parseCopilotEvents(EV_PATH)).toEqual([]);
  });

  it("parses newline-delimited events and skips malformed lines", async () => {
    files[EV_PATH] = `${JSON.stringify({ type: "session.start", data: { selectedModel: "x" } })}\nnot-json\n${JSON.stringify({ type: "assistant.turn_start", data: { turnId: "0" } })}\n`;
    const out = await parseCopilotEvents(EV_PATH);
    expect(out.length).toBe(2);
    expect(out[0].type).toBe("session.start");
    expect(out[1].type).toBe("assistant.turn_start");
  });
});

describe("createCopilotEventsReader — incremental", () => {
  it("holds partial trailing lines across reads", async () => {
    files[EV_PATH] = `${JSON.stringify({ type: "session.start", data: {} })}\n{"type":"assist`;
    const r = createCopilotEventsReader(EV_PATH);
    const first = await r.readIncremental();
    expect(first.newEntries.length).toBe(1);

    files[EV_PATH] += `ant.turn_start","data":{"turnId":"0"}}\n`;
    const second = await r.readIncremental();
    expect(second.newEntries.length).toBe(1);
    expect(second.newEntries[0].type).toBe("assistant.turn_start");
  });

  it("resets on file shrink", async () => {
    files[EV_PATH] = jsonl([
      { type: "session.start", data: {} },
      { type: "assistant.turn_start", data: { turnId: "0" } },
    ]);
    const r = createCopilotEventsReader(EV_PATH);
    await r.readIncremental();

    files[EV_PATH] = jsonl([{ type: "session.start", data: {} }]);
    const reset = await r.readIncremental();
    expect(reset.didReset).toBe(true);
    expect(reset.newEntries.length).toBe(1);
  });
});

describe("copilotEventsToSpans", () => {
  it("groups inner turns by interactionId into one user-visible turn", () => {
    const IID = "user-1";
    const events: CopilotEvent[] = [
      { type: "session.start", timestamp: "2025-01-01T00:00:00.000Z", data: { selectedModel: "gpt-5" } },
      { type: "user.message", timestamp: "2025-01-01T00:00:00.500Z", data: { content: "Hello there", interactionId: IID } },
      { type: "assistant.turn_start", timestamp: "2025-01-01T00:00:01.000Z", data: { turnId: "0", interactionId: IID } },
      { type: "assistant.turn_end", timestamp: "2025-01-01T00:00:02.000Z", data: { turnId: "0" } },
      { type: "assistant.turn_start", timestamp: "2025-01-01T00:00:02.100Z", data: { turnId: "1", interactionId: IID } },
      { type: "assistant.turn_end", timestamp: "2025-01-01T00:00:03.000Z", data: { turnId: "1" } },
    ];
    const turns = copilotEventsToSpans(events, { sessionId: "app-1", copilotSessionId: SID })
      .filter((s) => s.type === "turn");
    expect(turns).toHaveLength(1);
    expect(turns[0].startMs).toBe(Date.parse("2025-01-01T00:00:00.500Z"));
    expect(turns[0].endMs).toBe(Date.parse("2025-01-01T00:00:03.000Z"));
    expect(turns[0].status).toBe("success");
    expect((turns[0].meta as { model?: string }).model).toBe("gpt-5");
    expect(turns[0].name).toContain("Hello there");
  });

  it("starts a new turn when interactionId changes", () => {
    const events: CopilotEvent[] = [
      { type: "user.message", data: { content: "first", interactionId: "a" } },
      { type: "assistant.turn_start", data: { turnId: "0", interactionId: "a" } },
      { type: "assistant.turn_end", data: { turnId: "0" } },
      { type: "user.message", data: { content: "second", interactionId: "b" } },
      { type: "assistant.turn_start", data: { turnId: "1", interactionId: "b" } },
    ];
    const turns = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID })
      .filter((s) => s.type === "turn");
    expect(turns).toHaveLength(2);
    expect(turns[0].status).toBe("success"); // finalized when "b" started
    expect(turns[1].status).toBe("running"); // no turn_end yet
  });

  it("running turn (no turn_end) stays running", () => {
    const events: CopilotEvent[] = [
      { type: "user.message", timestamp: "2025-01-01T00:00:01.000Z", data: { content: "hi", interactionId: "a" } },
      { type: "assistant.turn_start", timestamp: "2025-01-01T00:00:01.100Z", data: { turnId: "0", interactionId: "a" } },
    ];
    const [turn] = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID });
    expect(turn.status).toBe("running");
    expect(turn.endMs).toBeUndefined();
  });

  it("accumulates outputTokens and reasoningText across inner turns of the same interaction", () => {
    const IID = "a";
    const events: CopilotEvent[] = [
      { type: "session.start", data: { selectedModel: "gpt-5" } },
      { type: "user.message", data: { content: "hi", interactionId: IID } },
      { type: "assistant.turn_start", data: { turnId: "0", interactionId: IID } },
      { type: "assistant.message", data: { outputTokens: 40, reasoningText: "Step 1", interactionId: IID } },
      { type: "assistant.turn_end", data: { turnId: "0" } },
      { type: "assistant.turn_start", data: { turnId: "1", interactionId: IID } },
      { type: "assistant.message", data: { outputTokens: 60, reasoningText: "Step 2", interactionId: IID } },
      { type: "assistant.turn_end", data: { turnId: "1" } },
    ];
    const [turn] = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID });
    const meta = turn.meta as { tokens: { output: number }; thinking: string };
    expect(meta.tokens.output).toBe(100);
    expect(meta.thinking).toBe("Step 1\n\nStep 2");
  });

  it("pairs tool.execution_start + tool.execution_complete under the active interaction's turn", () => {
    const IID = "a";
    const events: CopilotEvent[] = [
      { type: "user.message", data: { content: "run ls", interactionId: IID } },
      { type: "assistant.turn_start", data: { turnId: "0", interactionId: IID } },
      {
        type: "tool.execution_start",
        timestamp: "2025-01-01T00:00:02.000Z",
        data: { toolCallId: "tc_1", toolName: "bash", arguments: { cmd: "ls" } },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2025-01-01T00:00:03.000Z",
        data: {
          toolCallId: "tc_1",
          success: true,
          result: { content: "file1.txt\nfile2.txt" },
        },
      },
      { type: "assistant.turn_end", data: { turnId: "0" } },
    ];
    const spans = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID });
    const turn = spans.find((s) => s.type === "turn")!;
    const tool = spans.find((s) => s.type === "tool")!;
    expect(tool.parentId).toBe(turn.id);
    expect(tool.status).toBe("success");
    expect(tool.id).toBe("tool:tc_1");
    const meta = tool.meta as { toolResult?: { preview: string; isError: boolean } };
    expect(meta.toolResult?.preview).toContain("file1.txt");
    expect(meta.toolResult?.isError).toBe(false);
  });

  it("tool spans from multiple inner turns all attach to the same outer turn", () => {
    const IID = "a";
    const events: CopilotEvent[] = [
      { type: "user.message", data: { content: "hi", interactionId: IID } },
      { type: "assistant.turn_start", data: { turnId: "0", interactionId: IID } },
      { type: "tool.execution_start", data: { toolCallId: "t1", toolName: "bash" } },
      { type: "tool.execution_complete", data: { toolCallId: "t1", success: true, result: { content: "" } } },
      { type: "assistant.turn_end", data: { turnId: "0" } },
      { type: "assistant.turn_start", data: { turnId: "1", interactionId: IID } },
      { type: "tool.execution_start", data: { toolCallId: "t2", toolName: "grep" } },
      { type: "tool.execution_complete", data: { toolCallId: "t2", success: true, result: { content: "" } } },
      { type: "assistant.turn_end", data: { turnId: "1" } },
    ];
    const spans = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID });
    const turns = spans.filter((s) => s.type === "turn");
    const tools = spans.filter((s) => s.type === "tool");
    expect(turns).toHaveLength(1);
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.parentId === turns[0].id)).toBe(true);
  });

  it("marks tool span as error when success=false and propagates isError", () => {
    const events: CopilotEvent[] = [
      { type: "user.message", data: { content: "hi", interactionId: "a" } },
      { type: "assistant.turn_start", data: { turnId: "0", interactionId: "a" } },
      { type: "tool.execution_start", data: { toolCallId: "tc_1", toolName: "bash" } },
      {
        type: "tool.execution_complete",
        data: { toolCallId: "tc_1", success: false, result: { content: "bad" } },
      },
    ];
    const spans = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID });
    const tool = spans.find((s) => s.type === "tool")!;
    expect(tool.status).toBe("error");
    const meta = tool.meta as { toolResult?: { isError: boolean } };
    expect(meta.toolResult?.isError).toBe(true);
  });

  it("unmatched tool.execution_start stays 'running'", () => {
    const events: CopilotEvent[] = [
      { type: "user.message", data: { content: "hi", interactionId: "a" } },
      { type: "assistant.turn_start", data: { turnId: "0", interactionId: "a" } },
      { type: "tool.execution_start", data: { toolCallId: "tc_1", toolName: "bash" } },
    ];
    const spans = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID });
    const tool = spans.find((s) => s.type === "tool")!;
    expect(tool.status).toBe("running");
    expect(tool.endMs).toBeUndefined();
  });

  it("handles assistant.turn_start without a preceding user.message (resume mid-interaction)", () => {
    const events: CopilotEvent[] = [
      { type: "session.resume", data: { selectedModel: "gpt-5" } },
      { type: "assistant.turn_start", timestamp: "2025-01-01T00:00:01.000Z", data: { turnId: "5", interactionId: "mid" } },
      { type: "tool.execution_start", data: { toolCallId: "t1", toolName: "bash" } },
      { type: "tool.execution_complete", data: { toolCallId: "t1", success: true, result: { content: "" } } },
      { type: "assistant.turn_end", timestamp: "2025-01-01T00:00:02.000Z", data: { turnId: "5" } },
    ];
    const spans = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID });
    const turn = spans.find((s) => s.type === "turn")!;
    const tool = spans.find((s) => s.type === "tool")!;
    expect(turn.id).toBe(`turn:copilot:${SID}:mid`);
    expect(turn.startMs).toBe(Date.parse("2025-01-01T00:00:01.000Z"));
    expect(turn.status).toBe("success");
    expect(tool.parentId).toBe(turn.id);
  });

  it("ignores events with missing interactionId", () => {
    const events: CopilotEvent[] = [
      // Malformed — no interactionId on any of these.
      { type: "user.message", data: { content: "orphan" } },
      { type: "assistant.turn_start", data: { turnId: "0" } },
      { type: "assistant.turn_end", data: { turnId: "0" } },
    ];
    const spans = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID });
    expect(spans.filter((s) => s.type === "turn")).toHaveLength(0);
  });

  it("produces stable span ids across re-parses", () => {
    const events: CopilotEvent[] = [
      { type: "user.message", data: { content: "hi", interactionId: "int-a" } },
      { type: "assistant.turn_start", data: { turnId: "0", interactionId: "int-a" } },
      { type: "tool.execution_start", data: { toolCallId: "tc_1", toolName: "bash" } },
    ];
    const a = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID }).map((s) => s.id);
    const b = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID }).map((s) => s.id);
    expect(a).toEqual(b);
    expect(a).toContain("tool:tc_1");
    expect(a).toContain(`turn:copilot:${SID}:int-a`);
  });
});
