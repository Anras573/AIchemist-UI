import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TitleBar } from "./TitleBar";

describe("TitleBar", () => {
  it("renders the app name", () => {
    render(<TitleBar />);
    expect(screen.getByText("AIchemist")).toBeInTheDocument();
  });

  it("marks the bar as a drag region for the Electron window", () => {
    const { container } = render(<TitleBar />);
    const bar = container.firstChild as HTMLElement;
    expect(bar.dataset.dragRegion).toBe("true");
  });

  it("renders two spacer divs to keep the title centred", () => {
    const { container } = render(<TitleBar />);
    // The bar itself + two spacer divs + the text span = 4 children/nodes
    const bar = container.firstChild as HTMLElement;
    const divChildren = Array.from(bar.children).filter(
      (el) => el.tagName === "DIV"
    );
    expect(divChildren).toHaveLength(2);
  });
});
