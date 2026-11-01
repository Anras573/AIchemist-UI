import { beforeEach, describe, it, expect, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import type { MessageAttachment } from "@/types";
import {
  MessageAttachmentChips,
  formatBytes,
  isPreviewableImage,
  _clearAttachmentPreviewCache,
} from "./ComposerAttachments";

const img = (over: Partial<MessageAttachment> = {}): MessageAttachment => ({
  id: "a1",
  name: "shot.png",
  media_type: "image/png",
  size: 2048,
  path: "/a/shot.png",
  ...over,
});
const txt: MessageAttachment = {
  id: "a2",
  name: "notes.md",
  media_type: "text/markdown",
  size: 10,
  path: "/a/notes.md",
};

beforeEach(() => _clearAttachmentPreviewCache());

describe("formatBytes", () => {
  it("formats B / KB / MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("isPreviewableImage", () => {
  it("accepts supported small images only", () => {
    expect(isPreviewableImage(img())).toBe(true);
    expect(isPreviewableImage(img({ media_type: "image/svg+xml" }))).toBe(false);
    expect(isPreviewableImage(img({ size: 9 * 1024 * 1024 }))).toBe(false);
    expect(isPreviewableImage(txt)).toBe(false);
  });
});

describe("MessageAttachmentChips", () => {
  it("renders a chip for non-image files without calling IPC", () => {
    const readAttachmentImage = vi.fn();
    renderWithProviders(<MessageAttachmentChips messageId="m1" attachments={[txt]} />, {
      ipc: { readAttachmentImage },
    });
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(readAttachmentImage).not.toHaveBeenCalled();
  });

  it("loads an image thumbnail by message + attachment id and opens it larger on click", async () => {
    const readAttachmentImage = vi.fn().mockResolvedValue({ dataUrl: "data:image/png;base64,AA==" });
    renderWithProviders(<MessageAttachmentChips messageId="m1" attachments={[img()]} />, {
      ipc: { readAttachmentImage },
    });

    const thumb = await screen.findByRole("button", { name: "View shot.png" });
    expect(readAttachmentImage).toHaveBeenCalledWith({ messageId: "m1", attachmentId: "a1" });
    expect(thumb.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AA==");

    fireEvent.click(thumb);
    await waitFor(() => expect(screen.getAllByAltText("shot.png").length).toBe(2));
  });

  it("falls back to a chip when the preview can't be read", async () => {
    const readAttachmentImage = vi.fn().mockRejectedValue(new Error("gone"));
    renderWithProviders(<MessageAttachmentChips messageId="m1" attachments={[img()]} />, {
      ipc: { readAttachmentImage },
    });
    expect(await screen.findByText("shot.png")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View shot.png" })).toBeNull();
  });

  it("reuses a cached preview on remount instead of re-reading the file", async () => {
    const readAttachmentImage = vi.fn().mockResolvedValue({ dataUrl: "data:image/png;base64,AA==" });
    const first = renderWithProviders(<MessageAttachmentChips messageId="m1" attachments={[img()]} />, {
      ipc: { readAttachmentImage },
    });
    await screen.findByRole("button", { name: "View shot.png" });
    first.unmount();

    renderWithProviders(<MessageAttachmentChips messageId="m1" attachments={[img()]} />, {
      ipc: { readAttachmentImage },
    });
    expect(await screen.findByRole("button", { name: "View shot.png" })).toBeInTheDocument();
    expect(readAttachmentImage).toHaveBeenCalledTimes(1);
  });
});
