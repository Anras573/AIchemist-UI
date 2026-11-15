import { describe, it, expect } from "vitest";
import {
  computeHistoryBudget,
  estimateTokens,
  MAX_REPLAYED_TOOL_RESULT_CHARS,
  trimUnitsToBudget,
  truncateToolResult,
  type HistoryUnit,
} from "./history-budget";

const unit = (label: string, tokens: number): HistoryUnit<string> => ({ messages: [label], tokens });

describe("truncateToolResult", () => {
  it("leaves small results alone and marks truncated ones", () => {
    expect(truncateToolResult("ok")).toBe("ok");
    const out = truncateToolResult("x".repeat(MAX_REPLAYED_TOOL_RESULT_CHARS + 500));
    expect(out.startsWith("x".repeat(MAX_REPLAYED_TOOL_RESULT_CHARS))).toBe(true);
    expect(out).toContain("truncated 500 characters");
  });
});

describe("computeHistoryBudget", () => {
  it("uses a conservative default and subtracts reserved tokens", () => {
    expect(computeHistoryBudget(null, 0)).toBeGreaterThan(0);
    expect(computeHistoryBudget(10_000, 1000)).toBe(6000);
    expect(computeHistoryBudget(1000, 5000)).toBe(0);
  });
});

describe("trimUnitsToBudget", () => {
  it("keeps everything when under budget", () => {
    const units = [unit("a", 10), unit("b", 10)];
    expect(trimUnitsToBudget(units, 100)).toEqual(["a", "b"]);
  });

  it("keeps the newest units and drops the oldest in coarse batches", () => {
    const units = Array.from({ length: 30 }, (_, i) => unit(`u${i}`, 10));
    const out = trimUnitsToBudget(units, 100, 8); // fits 10 units → cut 20 → rounded up to 24
    expect(out[out.length - 1]).toBe("u29");
    expect(out[0]).toBe("u24");
    // One more turn (31 units) keeps the same prefix cut → stable prefix.
    const next = trimUnitsToBudget([...units, unit("u30", 10)], 100, 8);
    expect(next[0]).toBe("u24");
  });

  it("always keeps the newest unit even if it alone exceeds the budget", () => {
    expect(trimUnitsToBudget([unit("old", 5), unit("huge", 1000)], 10)).toEqual(["huge"]);
  });

  it("never splits a unit's messages", () => {
    const pair: HistoryUnit<string> = { messages: ["call", "result"], tokens: 50 };
    const out = trimUnitsToBudget([unit("old", 10), pair, unit("cur", 10)], 65, 1);
    expect(out).toEqual(["call", "result", "cur"]);
  });

  it("advances the cut so the replay starts with a user unit", () => {
    const u = (l: string, user: boolean): HistoryUnit<string> => ({ messages: [l], tokens: 10, startsWithUser: user });
    const units = [u("u0", true), u("a0", false), u("u1", true), u("a1", false), u("u2", true)];
    // Budget fits the last 2 units (a1,u2 → cut=3, an assistant) → advance to u2.
    expect(trimUnitsToBudget(units, 20, 1)).toEqual(["u2"]);
    // Budget fits 4 (cut=1, assistant) → advance to u1.
    expect(trimUnitsToBudget(units, 40, 1)).toEqual(["u1", "a1", "u2"]);
  });

  it("estimates tokens roughly by chars/4", () => {
    expect(estimateTokens("12345678")).toBe(2);
  });
});
