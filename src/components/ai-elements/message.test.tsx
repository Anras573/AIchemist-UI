import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Message, MessageAction, MessageContent } from "./message";
import { Shimmer } from "./shimmer";

describe("Message", () => {
  it("tags the root with its role for group-[.is-user] styling", () => {
    const { container, rerender } = render(
      <Message from="user">
        <MessageContent>hi</MessageContent>
      </Message>
    );
    expect(container.querySelector(".group")).toHaveClass("is-user");
    expect(container.querySelector("[data-slot=message]")).toHaveAttribute(
      "data-align",
      "end"
    );
    rerender(
      <Message from="assistant">
        <MessageContent>hello</MessageContent>
      </Message>
    );
    expect(container.querySelector(".group")).toHaveClass("is-assistant");
    expect(container.querySelector("[data-slot=message]")).toHaveAttribute(
      "data-align",
      "start"
    );
  });

  it("keeps sibling children (labels, chips) in a column with the bubble", () => {
    render(
      <Message from="assistant">
        <span>agent-name</span>
        <MessageContent>body</MessageContent>
      </Message>
    );
    const body = screen.getByText("agent-name").parentElement!;
    expect(body).toHaveAttribute("data-slot", "message-content");
    expect(body).toContainElement(screen.getByText("body"));
  });

  it("styles the bubble by role", () => {
    const { container } = render(
      <Message from="user">
        <MessageContent>hi</MessageContent>
      </Message>
    );
    expect(container.querySelector("[data-slot=bubble]")).toHaveAttribute(
      "data-variant",
      "default"
    );
  });

  it("labels a message action for assistive tech", () => {
    render(<MessageAction label="Copy">x</MessageAction>);
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});

describe("Shimmer", () => {
  it("renders its text with the CSS shimmer utility", () => {
    render(<Shimmer duration={3}>Thinking…</Shimmer>);
    const el = screen.getByText("Thinking…");
    expect(el).toHaveClass("shimmer");
    expect(el.style.getPropertyValue("--shimmer-duration")).toBe("3s");
  });
});
