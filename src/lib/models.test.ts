import { describe, it, expect } from "vitest";
import {
  getModelLabel,
  getLogoProvider,
  getModelContextWindow,
  ANTHROPIC_MODELS,
} from "@/lib/models";

describe("getModelLabel", () => {
  it("returns the label for each known Anthropic model", () => {
    for (const m of ANTHROPIC_MODELS) {
      expect(getModelLabel(m.provider, m.model)).toBe(m.label);
    }
  });

  it("transforms an unknown model ID — dashes to spaces, title case", () => {
    expect(getModelLabel("copilot", "gpt-4o-mini")).toBe("Gpt 4o Mini");
  });

  it("converts a dash immediately before a digit to a space", () => {
    // claude-3-5 → claude 3 5 → Claude 3 5
    expect(getModelLabel("anthropic", "claude-3-5")).toBe("Claude 3 5");
  });

  it("handles a model ID with a date-style suffix", () => {
    // -20250603: the leading dash + digit triggers the digit rule, rest stays
    expect(getModelLabel("copilot", "gpt-4-20250603")).toBe(
      "Gpt 4 20250603"
    );
  });

  it("does not throw on an empty model ID", () => {
    expect(() => getModelLabel("anthropic", "")).not.toThrow();
    expect(getModelLabel("anthropic", "")).toBe("");
  });

  it("passes through a model that is already clean", () => {
    expect(getModelLabel("custom", "mymodel")).toBe("Mymodel");
  });
});

describe("getLogoProvider", () => {
  it("maps copilot to github-copilot", () => {
    expect(getLogoProvider("copilot")).toBe("github-copilot");
  });

  it("passes anthropic through unchanged", () => {
    expect(getLogoProvider("anthropic")).toBe("anthropic");
  });

  it("passes an unknown provider through unchanged", () => {
    expect(getLogoProvider("openai")).toBe("openai");
  });
});

describe("getModelContextWindow", () => {
  it("returns 200_000 for all known Anthropic claude- models", () => {
    expect(getModelContextWindow("claude-opus-4-6")).toBe(200_000);
    expect(getModelContextWindow("claude-sonnet-4-6")).toBe(200_000);
    expect(getModelContextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("matches gpt-4o-mini before gpt-4o (more specific prefix wins)", () => {
    // gpt-4o-mini should match the gpt-4o-mini entry (128K), not gpt-4o
    expect(getModelContextWindow("gpt-4o-mini")).toBe(128_000);
  });

  it("matches gpt-4o to 128K", () => {
    expect(getModelContextWindow("gpt-4o")).toBe(128_000);
  });

  it("returns 200_000 for o1, o3 models", () => {
    expect(getModelContextWindow("o1")).toBe(200_000);
    expect(getModelContextWindow("o3")).toBe(200_000);
    expect(getModelContextWindow("o3-mini")).toBe(200_000);
  });

  it("returns 1_000_000 for gemini-2.0-flash", () => {
    expect(getModelContextWindow("gemini-2.0-flash")).toBe(1_000_000);
  });

  it("is case-insensitive", () => {
    expect(getModelContextWindow("Claude-Sonnet-4-6")).toBe(200_000);
    expect(getModelContextWindow("GPT-4O")).toBe(128_000);
  });

  it("returns null for an unknown model ID", () => {
    expect(getModelContextWindow("unknown-model-xyz")).toBeNull();
    expect(getModelContextWindow("")).toBeNull();
  });

  it("trims leading/trailing whitespace before matching", () => {
    expect(getModelContextWindow("  claude-sonnet-4-6  ")).toBe(200_000);
    expect(getModelContextWindow(" gpt-4o ")).toBe(128_000);
  });
});
