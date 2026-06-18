// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOOL_ROUNDS,
  MAX_MAX_TOOL_ROUNDS,
  MIN_MAX_TOOL_ROUNDS,
  parseMaxToolRounds,
} from "./settings";

describe("parseMaxToolRounds", () => {
  it("returns the default for empty / missing / non-numeric input", () => {
    expect(parseMaxToolRounds(undefined)).toBe(DEFAULT_MAX_TOOL_ROUNDS);
    expect(parseMaxToolRounds("")).toBe(DEFAULT_MAX_TOOL_ROUNDS);
    expect(parseMaxToolRounds("   ")).toBe(DEFAULT_MAX_TOOL_ROUNDS);
    expect(parseMaxToolRounds("abc")).toBe(DEFAULT_MAX_TOOL_ROUNDS);
  });

  it("parses a valid in-range value", () => {
    expect(parseMaxToolRounds("12")).toBe(12);
    expect(parseMaxToolRounds(" 3 ")).toBe(3);
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(parseMaxToolRounds("0")).toBe(MIN_MAX_TOOL_ROUNDS);
    expect(parseMaxToolRounds("-5")).toBe(MIN_MAX_TOOL_ROUNDS);
    expect(parseMaxToolRounds("9999")).toBe(MAX_MAX_TOOL_ROUNDS);
  });

  it("ignores a trailing fractional / suffix portion (parseInt semantics)", () => {
    expect(parseMaxToolRounds("8.9")).toBe(8);
    expect(parseMaxToolRounds("16rounds")).toBe(16);
  });
});
