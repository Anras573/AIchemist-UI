import { useEffect, useState } from "react";
import { FileIcon, ImageIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  PromptInputButton,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import type { MessageAttachment } from "@/types";

/** Attachment limits — mirrored from `electron/attachments.ts` (renderer can't value-import it). */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Paperclip button in the input bar footer — opens the native file picker. */
export function AttachFilesButton({ disabled }: { disabled?: boolean }) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      aria-label="Attach files"
      tooltip="Attach images or files (or drop / paste them)"
      disabled={disabled}
      onClick={() => attachments.openFileDialog()}
    >
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  );
}

/** Pending attachments for the message being composed, with remove buttons. */
export function ComposerAttachmentStrip() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2" data-testid="composer-attachments">
      {attachments.files.map((file) => {
        const isImage = file.mediaType?.startsWith("image/");
        return (
          <span
            key={file.id}
            className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-border/60 bg-muted/60 py-0.5 pl-1 pr-1.5 text-xs"
          >
            {isImage && file.url ? (
              <img src={file.url} alt="" className="size-5 rounded object-cover" />
            ) : (
              <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="truncate">{file.filename ?? "attachment"}</span>
            <button
              type="button"
              onClick={() => attachments.remove(file.id)}
              className="leading-none text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${file.filename ?? "attachment"}`}
            >
              <XIcon className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** Image types the main process will preview (mirrors `PREVIEW_IMAGE_TYPES` in electron/attachments.ts). */
const PREVIEWABLE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

export function isPreviewableImage(a: MessageAttachment): boolean {
  return PREVIEWABLE_TYPES.includes(a.media_type.toLowerCase()) && a.size <= MAX_PREVIEW_BYTES;
}

// Data URLs of already-loaded previews, keyed by attachment id. The timeline is
// virtualized, so a bubble remounts every time it scrolls back into view —
// without this each remount would re-read and re-encode the file over IPC.
const PREVIEW_CACHE_LIMIT = 40;
const previewCache = new Map<string, string>();

function cachePreview(id: string, dataUrl: string): void {
  previewCache.delete(id);
  previewCache.set(id, dataUrl);
  if (previewCache.size > PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next().value;
    if (oldest !== undefined) previewCache.delete(oldest);
  }
}

/** Test seam. */
export function _clearAttachmentPreviewCache(): void {
  previewCache.clear();
}

function AttachmentChip({ attachment }: { attachment: MessageAttachment }) {
  return (
    <span
      title={attachment.path}
      className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-border/60 bg-muted/60 px-2 py-1 text-xs text-foreground"
    >
      {attachment.media_type.startsWith("image/") ? (
        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="truncate">{attachment.name}</span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(attachment.size)}</span>
    </span>
  );
}

/**
 * Fixed-size thumbnail of a sent image (fixed so the virtualized timeline doesn't
 * shift when it loads); click to view it larger. Falls back to a plain chip if the
 * file is gone or can't be read.
 */
function ImageAttachmentPreview({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: MessageAttachment;
}) {
  const ipc = useIpc();
  const [src, setSrc] = useState<string | null>(() => previewCache.get(attachment.id) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (src) return;
    let cancelled = false;
    ipc
      .readAttachmentImage({ messageId, attachmentId: attachment.id })
      .then(({ dataUrl }) => {
        cachePreview(attachment.id, dataUrl);
        if (!cancelled) setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [ipc, messageId, attachment.id, src]);

  if (failed) return <AttachmentChip attachment={attachment} />;

  if (!src) {
    return (
      <span
        aria-label={`Loading ${attachment.name}`}
        className="inline-block size-28 animate-pulse rounded-md border border-border/60 bg-muted/60"
      />
    );
  }

  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            aria-label={`View ${attachment.name}`}
            title={attachment.name}
            className="overflow-hidden rounded-md border border-border/60 bg-muted/60 transition-opacity hover:opacity-90"
          />
        }
      >
        <img src={src} alt={attachment.name} className="size-28 object-cover" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle className="truncate pr-8">{attachment.name}</DialogTitle>
        <img
          src={src}
          alt={attachment.name}
          className="mx-auto max-h-[75vh] max-w-full rounded-md object-contain"
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Attachments already sent with a message: image thumbnails (click to enlarge)
 * and chips for everything else.
 */
export function MessageAttachmentChips({
  messageId,
  attachments,
}: {
  messageId: string;
  attachments: MessageAttachment[];
}) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5" data-testid="message-attachments">
      {attachments.map((a) =>
        isPreviewableImage(a) ? (
          <ImageAttachmentPreview key={a.id} messageId={messageId} attachment={a} />
        ) : (
          <AttachmentChip key={a.id} attachment={a} />
        )
      )}
    </div>
  );
}
