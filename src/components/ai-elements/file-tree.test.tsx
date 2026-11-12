import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FileTree,
  FileTreeActions,
  FileTreeFile,
  FileTreeFolder,
} from "./file-tree";

describe("FileTree", () => {
  it("expands a folder and selects it when its row is clicked", async () => {
    const onSelect = vi.fn();
    const onExpandedChange = vi.fn();
    render(
      <FileTree onSelect={onSelect} onExpandedChange={onExpandedChange}>
        <FileTreeFolder name="src" path="src">
          <FileTreeFile name="a.ts" path="src/a.ts" />
        </FileTreeFolder>
      </FileTree>
    );
    await userEvent.click(screen.getByRole("button", { name: /src/ }));
    expect(onSelect).toHaveBeenCalledWith("src");
    expect(onExpandedChange).toHaveBeenCalledWith(new Set(["src"]));
    expect(screen.getByText("a.ts")).toBeInTheDocument();
  });

  it("calls onSelect with the path when a file is clicked", async () => {
    const onSelect = vi.fn();
    render(
      <FileTree onSelect={onSelect}>
        <FileTreeFile name="a.ts" path="a.ts" />
      </FileTree>
    );
    await userEvent.click(screen.getByRole("button", { name: /a\.ts/ }));
    expect(onSelect).toHaveBeenCalledWith("a.ts");
  });

  it("renders actions beside the file button, not inside it", async () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    render(
      <FileTree onSelect={onSelect}>
        <FileTreeFile name="a.ts" path="a.ts">
          <span>custom label</span>
          <FileTreeActions>
            <button onClick={onAction} type="button">
              act
            </button>
          </FileTreeActions>
        </FileTreeFile>
      </FileTree>
    );
    const row = screen.getByRole("button", { name: "custom label" });
    expect(row).not.toContainElement(screen.getByRole("button", { name: "act" }));
    await userEvent.click(screen.getByRole("button", { name: "act" }));
    expect(onAction).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
