import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Context,
  ContextContent,
  ContextContentHeader,
  ContextTrigger,
} from "./context";

describe("Context", () => {
  it("shows the percent used on the trigger", () => {
    render(
      <Context maxTokens={200} usedTokens={50}>
        <ContextTrigger />
      </Context>
    );
    expect(
      screen.getByRole("button", { name: "Context window usage: 25%" })
    ).toHaveTextContent("25%");
  });

  it("renders a labelled progress bar in the header", async () => {
    render(
      <Context maxTokens={200} usedTokens={50} defaultOpen>
        <ContextTrigger />
        <ContextContent>
          <ContextContentHeader />
        </ContextContent>
      </Context>
    );
    const bar = await screen.findByRole("progressbar", { name: "Context used" });
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("25% used")).toBeInTheDocument();
  });
});
