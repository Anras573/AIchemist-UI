// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import RealDatabase from "better-sqlite3";
import { migrate } from "../db";
import { createSession, saveMessage, createPlaceholderMessage, saveToolCall, updateToolCallStatus } from "../sessions";
import { MAX_REPLAYED_TOOL_RESULT_CHARS } from "./history-budget";

vi.mock("ollama", () => ({ default: {}, Ollama: vi.fn() }));

import { _loadHistoryForTests as ollamaHistory } from "./ollama";
import { _loadHistoryForTests as compatHistory, _withCurrentPromptForTests } from "./openai-compat";

let db: RealDatabase.Database;
let sessionId: string;

beforeEach(() => {
  db = new RealDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p','p','/p','now')").run();
  sessionId = createSession(db, "p").id;
});

function addTurn(i: number, result?: string) {
  saveMessage(db, { sessionId, role: "user", content: `question ${i}` });
  const a = createPlaceholderMessage(db, { sessionId });
  if (result !== undefined) {
    saveToolCall(db, { id: `tc${i}`, messageId: a.id, name: "web_fetch", args: { url: "u" }, status: "pending_approval", category: "web" });
    updateToolCallStatus(db, `tc${i}`, "complete", result);
  }
  db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(`answer ${i}`, a.id);
}

async function countStatements(fn: () => Promise<unknown>): Promise<number> {
  const proto = Object.getPrototypeOf(db.prepare("SELECT 1")) as { all: (...a: unknown[]) => unknown };
  const origAll = proto.all;
  let n = 0;
  proto.all = function (this: unknown, ...args: unknown[]) {
    n++;
    return origAll.apply(this, args);
  };
  try {
    await fn();
  } finally {
    proto.all = origAll;
  }
  return n;
}

describe("history replay", () => {
  it("truncates historical tool results (full result stays in the DB)", async () => {
    const big = "y".repeat(MAX_REPLAYED_TOOL_RESULT_CHARS * 5);
    addTurn(0, big);
    const history = await ollamaHistory(db, sessionId, "none");
    const tool = history.find((m) => m.role === "tool")!;
    expect(tool.content.length).toBeLessThan(big.length);
    expect(tool.content).toContain("truncated");
    const stored = db.prepare("SELECT result FROM tool_calls").get() as { result: string };
    expect(JSON.parse(stored.result)).toBe(big);
  });

  it("bounds a long session, keeping the newest turns and the current prompt", async () => {
    for (let i = 0; i < 200; i++) addTurn(i);
    saveMessage(db, { sessionId, role: "user", content: "current prompt" });
    const history = await ollamaHistory(db, sessionId, "none", false, 500);
    expect(history.length).toBeLessThan(400);
    expect(history[history.length - 1].content).toBe("current prompt");
    expect(history.some((m) => m.content === "answer 199")).toBe(true);
    expect(history.some((m) => m.content === "question 0")).toBe(false);
  });

  it("never splits a tool call from its result (openai-compat)", async () => {
    for (let i = 0; i < 60; i++) addTurn(i, `result ${i}`);
    for (const budget of [50, 120, 333, 900]) {
      const msgs = await compatHistory(db, sessionId, "none", false, budget);
      msgs.forEach((m, idx) => {
        if (m.role === "tool") expect(msgs[idx - 1].role).toBe("assistant");
        if (m.role === "assistant" && Array.isArray(m.content) && m.content.some((p) => p.type === "tool-call")) {
          expect(msgs[idx + 1]?.role).toBe("tool");
        }
      });
    }
  });

  it("issues a constant number of SQL statements regardless of message count", async () => {
    addTurn(0, "r");
    const small = await countStatements(() => ollamaHistory(db, sessionId, "none"));
    for (let i = 1; i < 50; i++) addTurn(i, "r");
    const large = await countStatements(() => ollamaHistory(db, sessionId, "none"));
    expect(large).toBe(small);
  });

  it("withCurrentPrompt still preserves inlined image parts", () => {
    const history = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "old" },
          { type: "image" as const, image: "AAAA", mediaType: "image/png" },
        ],
      },
    ];
    const out = _withCurrentPromptForTests(history, "new");
    expect(out[0].content).toEqual([
      { type: "text", text: "new" },
      { type: "image", image: "AAAA", mediaType: "image/png" },
    ]);
  });
});
