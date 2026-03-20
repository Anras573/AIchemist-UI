import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("passes a single class through unchanged", () => {
    expect(cn("text-sm")).toBe("text-sm");
  });

  it("joins multiple classes with a space", () => {
    expect(cn("text-sm", "font-bold")).toBe("text-sm font-bold");
  });

  it("drops falsy values", () => {
    expect(cn("text-sm", false, undefined, null, "font-bold")).toBe(
      "text-sm font-bold"
    );
  });

  it("resolves conflicting Tailwind classes — last one wins", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("handles object syntax — includes truthy keys", () => {
    expect(cn({ "text-sm": true, "font-bold": false })).toBe("text-sm");
  });

  it("handles array syntax", () => {
    expect(cn(["text-sm", "font-bold"])).toBe("text-sm font-bold");
  });

  it("returns an empty string when all inputs are falsy", () => {
    expect(cn(false, undefined, null)).toBe("");
  });
});
