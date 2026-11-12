import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DiffBlock } from "./DiffBlock";
import { parseUnifiedDiff } from "@/lib/parseUnifiedDiff";

const rows = parseUnifiedDiff(
  ["--- a.ts", "+++ a.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n")
);

describe("DiffBlock", () => {
  it("maps each row kind to a CodeBlockLine variant", () => {
    const { container } = render(<DiffBlock rows={rows} language="text" />);
    const variants = Array.from(
      container.querySelectorAll("[data-slot=code-block-line]")
    ).map((el) => el.getAttribute("data-variant"));
    expect(variants).toEqual([
      "default", // --- a.ts
      "default", // +++ a.ts
      "highlighted", // @@
      "default", // context
      "removed",
      "added",
    ]);
  });

  it("renders marker-stripped code and raw header text", () => {
    const { container } = render(<DiffBlock rows={rows} language="text" />);
    const text = Array.from(
      container.querySelectorAll("[data-slot=code-block-line]")
    ).map((el) => el.textContent);
    expect(text).toEqual(["--- a.ts", "+++ a.ts", "@@ -1,2 +1,2 @@", "keep", "old", "new"]);
  });

  it("uses the small, borderless block so it nests in the panel's own frame", () => {
    const { container } = render(<DiffBlock rows={rows} />);
    const block = container.querySelector("[data-slot=code-block]")!;
    expect(block).toHaveAttribute("data-size", "sm");
    expect(block).toHaveClass("border-0", "rounded-none");
  });

  it("keeps header rows unhighlighted and aligned with their row when highlighting", () => {
    // Highlighting loads asynchronously; whatever state it is in, row N must
    // still render row N's own text.
    const { container } = render(<DiffBlock rows={rows} language="typescript" />);
    const lines = container.querySelectorAll("[data-slot=code-block-line]");
    expect(lines).toHaveLength(rows.length);
    expect(lines[2].textContent).toBe("@@ -1,2 +1,2 @@");
    expect(lines[5].textContent).toBe("new");
  });

  it("renders nothing for no rows", () => {
    const { container } = render(<DiffBlock rows={[]} />);
    expect(container.querySelectorAll("[data-slot=code-block-line]")).toHaveLength(0);
  });
});
