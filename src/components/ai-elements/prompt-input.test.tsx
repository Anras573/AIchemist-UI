import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
} from "./prompt-input";

function setup(
  submitProps: React.ComponentProps<typeof PromptInputSubmit> = {},
  onSubmit = vi.fn()
) {
  render(
    <PromptInputProvider>
      <PromptInput onSubmit={onSubmit}>
        <PromptInputBody>
          <PromptInputTextarea placeholder="Ask" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputSubmit {...submitProps} />
        </PromptInputFooter>
      </PromptInput>
    </PromptInputProvider>
  );
  return onSubmit;
}

describe("PromptInput", () => {
  it("pads the textarea", () => {
    setup();
    expect(screen.getByPlaceholderText("Ask")).toHaveClass("p-3");
  });

  it("renders a round submit button with an up arrow when idle", () => {
    setup();
    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toHaveClass("rounded-full");
    expect(submit.querySelector("svg")).toHaveClass("lucide-arrow-up");
    expect(submit).toHaveAttribute("type", "submit");
  });

  it("swaps to a stop button while streaming and calls onStop", async () => {
    const onStop = vi.fn();
    setup({ status: "streaming", onStop });
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toHaveAttribute("type", "button");
    await userEvent.click(stop);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("submits the typed text on Enter and keeps Shift+Enter for newlines", async () => {
    const onSubmit = setup();
    const textarea = screen.getByPlaceholderText("Ask");
    await userEvent.type(textarea, "hello{Shift>}{Enter}{/Shift}world");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.type(textarea, "{Enter}");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].text).toBe("hello\nworld");
  });
});
