// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestQuestion, resolveQuestion, cancelSessionQuestions } from "./question";

function makeWebContents() {
  return { send: vi.fn() } as unknown as Electron.WebContents;
}

describe("requestQuestion / resolveQuestion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits session:question_required with the correct payload", () => {
    const wc = makeWebContents();
    requestQuestion(wc, "sess-1", "Which option?", ["A", "B"], "type here");

    expect(wc.send).toHaveBeenCalledOnce();
    const [channel, payload] = vi.mocked(wc.send).mock.calls[0];
    expect(channel).toBe("session:question_required");
    expect(payload).toMatchObject({
      session_id: "sess-1",
      question: "Which option?",
      options: ["A", "B"],
      placeholder: "type here",
    });
    expect(typeof payload.question_id).toBe("string");
    expect(payload.question_id.length).toBeGreaterThan(0);
  });

  it("resolves with the provided answer", async () => {
    const wc = makeWebContents();
    const promise = requestQuestion(wc, "sess-1", "What's your name?");

    const questionId = vi.mocked(wc.send).mock.calls[0][1].question_id;
    resolveQuestion(questionId, "Alice");

    await expect(promise).resolves.toBe("Alice");
  });

  it("resolves with an empty string for an empty answer", async () => {
    const wc = makeWebContents();
    const promise = requestQuestion(wc, "sess-1", "Confirm?");

    const questionId = vi.mocked(wc.send).mock.calls[0][1].question_id;
    resolveQuestion(questionId, "");

    await expect(promise).resolves.toBe("");
  });

  it("is a no-op when called with an unknown question ID", () => {
    expect(() => resolveQuestion("non-existent-id", "answer")).not.toThrow();
  });

  it("resolves each pending question independently when multiple are open", async () => {
    const wc = makeWebContents();
    const p1 = requestQuestion(wc, "sess-1", "Q1");
    const p2 = requestQuestion(wc, "sess-2", "Q2");

    const id1 = vi.mocked(wc.send).mock.calls[0][1].question_id;
    const id2 = vi.mocked(wc.send).mock.calls[1][1].question_id;

    resolveQuestion(id2, "answer-2");
    resolveQuestion(id1, "answer-1");

    await expect(p1).resolves.toBe("answer-1");
    await expect(p2).resolves.toBe("answer-2");
  });

  it("does not resolve a second time after the question has been consumed", async () => {
    const wc = makeWebContents();
    const promise = requestQuestion(wc, "sess-1", "Q?");
    const questionId = vi.mocked(wc.send).mock.calls[0][1].question_id;

    resolveQuestion(questionId, "first");
    await expect(promise).resolves.toBe("first");

    // Second call — entry is gone, should be no-op
    expect(() => resolveQuestion(questionId, "second")).not.toThrow();
  });
});

// ── cancelSessionQuestions ────────────────────────────────────────────────────

describe("cancelSessionQuestions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves all pending questions for the session with an empty string", async () => {
    const wc = makeWebContents();
    const p1 = requestQuestion(wc, "sess-cancel", "Q1");
    const p2 = requestQuestion(wc, "sess-cancel", "Q2");

    cancelSessionQuestions("sess-cancel");

    await expect(p1).resolves.toBe("");
    await expect(p2).resolves.toBe("");
  });

  it("does not affect questions for a different session", async () => {
    const wc = makeWebContents();
    const kept = requestQuestion(wc, "sess-other", "Keep me");
    const cancelled = requestQuestion(wc, "sess-cancel2", "Cancel me");

    cancelSessionQuestions("sess-cancel2");
    await expect(cancelled).resolves.toBe("");

    // Resolve the kept one normally — should still work
    const keptId = vi.mocked(wc.send).mock.calls[0][1].question_id;
    resolveQuestion(keptId, "kept-answer");
    await expect(kept).resolves.toBe("kept-answer");
  });

  it("is a no-op when there are no pending questions for the session", () => {
    expect(() => cancelSessionQuestions("sess-nonexistent")).not.toThrow();
  });
});
