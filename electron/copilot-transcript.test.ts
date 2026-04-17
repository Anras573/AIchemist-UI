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
  it("pairs turn_start/turn_end and sets model from session.start", () => {
    const events: CopilotEvent[] = [
      { type: "session.start", timestamp: "2025-01-01T00:00:00.000Z", data: { selectedModel: "gpt-5" } },
      { type: "assistant.turn_start", timestamp: "2025-01-01T00:00:01.000Z", data: { turnId: "0" } },
      { type: "assistant.turn_end", timestamp: "2025-01-01T00:00:03.000Z", data: { turnId: "0" } },
    ];
    const spans = copilotEventsToSpans(events, { sessionId: "app-1", copilotSessionId: SID });
    expect(spans).toHaveLength(1);
    expect(spans[0].type).toBe("turn");
    expect(spans[0].status).toBe("success");
    expect(spans[0].durationMs).toBe(2000);
    expect((spans[0].meta as { model?: string }).model).toBe("gpt-5");
  });

  it("running turn has no endMs and 'running' status until turn_end", () => {
    const events: CopilotEvent[] = [
      { type: "assistant.turn_start", timestamp: "2025-01-01T00:00:01.000Z", data: { turnId: "0" } },
    ];
    const spans = copilotEventsToSpans(events, { sessionId: "app-1", copilotSessionId: SID });
    expect(spans[0].status).toBe("running");
    expect(spans[0].endMs).toBeUndefined();
  });

  it("accumulates outputTokens and reasoningText on the active turn", () => {
    const events: CopilotEvent[] = [
      { type: "session.start", data: { selectedModel: "gpt-5" } },
      { type: "assistant.turn_start", timestamp: "2025-01-01T00:00:01.000Z", data: { turnId: "0" } },
      { type: "assistant.message", data: { outputTokens: 40, reasoningText: "Thinking step 1" } },
      { type: "assistant.message", data: { outputTokens: 60, reasoningText: "Thinking step 2" } },
      { type: "assistant.turn_end", timestamp: "2025-01-01T00:00:02.000Z", data: { turnId: "0" } },
    ];
    const [turn] = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID });
    const meta = turn.meta as { tokens: { output: number }; thinking: string };
    expect(meta.tokens.output).toBe(100);
    expect(meta.thinking).toBe("Thinking step 1\n\nThinking step 2");
  });

  it("pairs tool.execution_start + tool.execution_complete under the active turn", () => {
    const events: CopilotEvent[] = [
      { type: "assistant.turn_start", timestamp: "2025-01-01T00:00:01.000Z", data: { turnId: "0" } },
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
      { type: "assistant.turn_end", timestamp: "2025-01-01T00:00:04.000Z", data: { turnId: "0" } },
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

  it("marks tool span as error when success=false and propagates isError", () => {
    const events: CopilotEvent[] = [
      { type: "assistant.turn_start", data: { turnId: "0" } },
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
      { type: "assistant.turn_start", data: { turnId: "0" } },
      { type: "tool.execution_start", data: { toolCallId: "tc_1", toolName: "bash" } },
    ];
    const spans = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID });
    const tool = spans.find((s) => s.type === "tool")!;
    expect(tool.status).toBe("running");
    expect(tool.endMs).toBeUndefined();
  });

  it("produces stable span ids across re-parses", () => {
    const events: CopilotEvent[] = [
      { type: "assistant.turn_start", data: { turnId: "0" } },
      { type: "tool.execution_start", data: { toolCallId: "tc_1", toolName: "bash" } },
    ];
    const a = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID }).map((s) => s.id);
    const b = copilotEventsToSpans(events, { sessionId: "s", copilotSessionId: SID }).map((s) => s.id);
    expect(a).toEqual(b);
    expect(a).toContain("tool:tc_1");
    expect(a).toContain(`turn:copilot:${SID}:0`);
  });
});
