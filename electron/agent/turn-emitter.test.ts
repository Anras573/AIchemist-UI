// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import * as CH from "../ipc-channels";
import { TurnEmitter, clearLastUsage, getLastUsage } from "./turn-emitter";

function makeEmitter() {
  const send = vi.fn();
  const emitter = new TurnEmitter({ send } as never, "s-1");
  return { send, emitter };
}

describe("TurnEmitter", () => {
  it("emits SESSION_DELTA with the session id", () => {
    const { send, emitter } = makeEmitter();
    emitter.delta("hello");
    expect(send).toHaveBeenCalledWith(CH.SESSION_DELTA, { session_id: "s-1", text_delta: "hello" });
  });

  it("emits SESSION_TOOL_CALL with id, name and input", () => {
    const { send, emitter } = makeEmitter();
    emitter.toolCall("tc-1", "write_file", { path: "a.txt" });
    expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_CALL, {
      session_id: "s-1",
      tool_name: "write_file",
      tool_call_id: "tc-1",
      input: { path: "a.txt" },
    });
  });

  it("emits SESSION_TOOL_RESULT", () => {
    const { send, emitter } = makeEmitter();
    emitter.toolResult("write_file", "ok");
    expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, {
      session_id: "s-1",
      tool_name: "write_file",
      output: "ok",
    });
  });

  it("normalizes compaction payloads by injecting the session id", () => {
    const { send, emitter } = makeEmitter();
    emitter.compaction({ id: "c-1", trigger: "auto", pre_tokens: 10, timestamp: "t" });
    expect(send).toHaveBeenCalledWith(CH.SESSION_COMPACTION, {
      session_id: "s-1",
      compaction: { id: "c-1", trigger: "auto", pre_tokens: 10, timestamp: "t", session_id: "s-1" },
    });
  });

  it("emits usage, status, thinking and file change events", () => {
    const { send, emitter } = makeEmitter();
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    emitter.usage(usage);
    emitter.status("running");
    emitter.thinkingDelta("hm");
    emitter.thinkingDone();
    emitter.fileChange({ path: "/p/a.txt", relativePath: "a.txt", diff: "", operation: "write" });
    expect(send).toHaveBeenCalledWith(CH.SESSION_USAGE, { session_id: "s-1", usage });
    expect(send).toHaveBeenCalledWith(CH.SESSION_STATUS, { session_id: "s-1", status: "running" });
    expect(send).toHaveBeenCalledWith(CH.SESSION_THINKING_DELTA, { session_id: "s-1", text_delta: "hm" });
    expect(send).toHaveBeenCalledWith(CH.SESSION_THINKING_DONE, { session_id: "s-1" });
    expect(send).toHaveBeenCalledWith(CH.SESSION_FILE_CHANGE, {
      session_id: "s-1",
      file_change: { path: "/p/a.txt", relativePath: "a.txt", diff: "", operation: "write" },
    });
  });

  it("withoutDeltas() drops delta() but passes every other event through", () => {
    const { send, emitter } = makeEmitter();
    const silent = emitter.withoutDeltas();
    silent.delta("suppressed");
    silent.toolResult("read_file", "contents");
    expect(send).not.toHaveBeenCalledWith(CH.SESSION_DELTA, expect.anything());
    expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, {
      session_id: "s-1",
      tool_name: "read_file",
      output: "contents",
    });
  });
});

describe("getLastUsage / clearLastUsage", () => {
  it("defaults to all-zero usage for a session that never called usage()", () => {
    expect(getLastUsage("s-usage-unset")).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("reflects the last usage() reading for that session", () => {
    const { emitter } = makeEmitter();
    const usage = { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 };
    emitter.usage(usage);
    expect(getLastUsage("s-1")).toEqual(usage);
    clearLastUsage("s-1");
  });

  it("returns a fresh object each call — mutating the result never affects the shared store", () => {
    const first = getLastUsage("s-usage-fresh");
    first.input_tokens = 999;
    const second = getLastUsage("s-usage-fresh");
    expect(second.input_tokens).toBe(0);
    expect(first).not.toBe(second);
  });

  it("clearLastUsage resets a session back to all-zero", () => {
    const send = vi.fn();
    const emitter = new TurnEmitter({ send } as never, "s-usage-clear");
    emitter.usage({ input_tokens: 9, output_tokens: 9, cache_read_input_tokens: 9, cache_creation_input_tokens: 9 });
    clearLastUsage("s-usage-clear");
    expect(getLastUsage("s-usage-clear")).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
});
