import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./reasoning";

const tree = (props: React.ComponentProps<typeof Reasoning>) => (
  <Reasoning {...props}>
    <ReasoningTrigger />
    <ReasoningContent>some thoughts</ReasoningContent>
  </Reasoning>
);

describe("Reasoning", () => {
  it("shows a running 'Thinking' line while streaming", () => {
    render(tree({ isStreaming: true }));
    const title = screen.getByText("Thinking…");
    expect(title.closest("[data-slot=trace-line]")).toHaveAttribute(
      "data-status",
      "running"
    );
    expect(screen.getByText("some thoughts")).toBeVisible();
  });

  it("reports the duration once finished", () => {
    render(tree({ duration: 5, defaultOpen: false }));
    expect(screen.getByText("Thought for 5s")).toBeInTheDocument();
  });

  it("falls back to a generic title with no duration", () => {
    render(tree({ defaultOpen: false }));
    expect(screen.getByText("Thought for a moment")).toBeInTheDocument();
  });

  it("closes itself when streaming finishes and notifies onOpenChange", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(tree({ isStreaming: true, onOpenChange }));
    rerender(tree({ isStreaming: false, onOpenChange }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles when the trigger is clicked", async () => {
    render(tree({ defaultOpen: false }));
    const trigger = screen.getByRole("button");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});
