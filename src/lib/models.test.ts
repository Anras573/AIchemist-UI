import { describe, it, expect } from "vitest";
import {
  getModelLabel,
  getLogoProvider,
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
