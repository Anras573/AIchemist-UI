import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders its children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("has data-slot='button'", () => {
    render(<Button>x</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("data-slot", "button");
  });

  it("calls onClick when clicked", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click me</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not call onClick when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Click me
      </Button>
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies the outline variant class", () => {
    render(<Button variant="outline">x</Button>);
    // Verify the variant is applied — outline uses a border style
    expect(screen.getByRole("button")).toHaveClass("border");
  });
});
