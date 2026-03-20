import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "@/components/ui/badge";

describe("Badge", () => {
  it("renders its text content", () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("has data-slot='badge'", () => {
    render(<Badge>x</Badge>);
    expect(screen.getByText("x")).toHaveAttribute("data-slot", "badge");
  });

  it("merges a custom className", () => {
    render(<Badge className="custom-class">x</Badge>);
    expect(screen.getByText("x")).toHaveClass("custom-class");
  });
});
