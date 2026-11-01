import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageAttachmentChips, formatBytes } from "./ComposerAttachments";

describe("formatBytes", () => {
  it("formats B / KB / MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("MessageAttachmentChips", () => {
  it("renders a chip per attachment with name and size", () => {
    render(
      <MessageAttachmentChips
        attachments={[
          { id: "1", name: "shot.png", media_type: "image/png", size: 2048, path: "/a/shot.png" },
          { id: "2", name: "notes.md", media_type: "text/markdown", size: 10, path: "/a/notes.md" },
        ]}
      />
    );
    expect(screen.getByText("shot.png")).toBeInTheDocument();
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
  });
});
