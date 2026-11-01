import { FileIcon, ImageIcon, PaperclipIcon, XIcon } from "lucide-react";
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

/** Read-only chips for attachments already sent with a message. */
export function MessageAttachmentChips({ attachments }: { attachments: MessageAttachment[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5" data-testid="message-attachments">
      {attachments.map((a) => (
        <span
          key={a.id}
          title={a.path}
          className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-border/60 bg-muted/60 px-2 py-1 text-xs text-foreground"
        >
          {a.media_type.startsWith("image/") ? (
            <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="truncate">{a.name}</span>
          <span className="shrink-0 text-muted-foreground">{formatBytes(a.size)}</span>
        </span>
      ))}
    </div>
  );
}
