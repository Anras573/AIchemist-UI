import fs from "fs";
import os from "os";
import path from "path";
import type { MessageAttachment } from "../src/types/index";

/**
 * User-supplied message attachments (images / files dropped or picked in the
 * input bar).
 *
 * Bytes live on disk under `~/.aichemist/attachments/<sessionId>/` — NOT in the
 * project (we must not pollute the user's repo) and NOT in SQLite (blobs would
 * bloat the DB and every paginated history load). The `messages.attachments`
 * column only stores metadata including the absolute path. At turn time the
 * path is appended to the prompt (see `appendAttachmentsToPrompt`) so every
 * provider can reference the file with whatever file tool it already has.
 */

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface AttachmentInput {
  name: string;
  mediaType: string;
  /** `data:<mime>;base64,<payload>` URL as produced by the renderer. */
  dataUrl: string;
}

let rootOverride: string | null = null;

/** Test seam: redirect the attachments root to a temp dir (null restores default). */
export function _setAttachmentsRootForTests(dir: string | null): void {
  rootOverride = dir;
}

export function attachmentsRoot(): string {
  return rootOverride ?? path.join(os.homedir(), ".aichemist", "attachments");
}

function sessionDir(sessionId: string): string {
  // Session ids are UUIDs, but never trust a path segment.
  return path.join(attachmentsRoot(), sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/** Strip directory parts and anything odd from a user-supplied file name. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "").trim();
  return (cleaned || "attachment").slice(0, 120);
}

function decodeDataUrl(dataUrl: string): Buffer {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Attachment is not a base64 data URL");
  return Buffer.from(match[1], "base64");
}

/** Decode and persist attachments; returns the metadata to store on the message. */
export function saveAttachments(sessionId: string, inputs: AttachmentInput[]): MessageAttachment[] {
  if (inputs.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE})`);
  }
  const dir = sessionDir(sessionId);
  const saved: MessageAttachment[] = [];
  try {
    for (const input of inputs) {
      const bytes = decodeDataUrl(input.dataUrl);
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `"${input.name}" is too large (${Math.round(bytes.length / 1024 / 1024)} MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`
        );
      }
      fs.mkdirSync(dir, { recursive: true });
      const id = crypto.randomUUID();
      const name = sanitizeFileName(input.name);
      const filePath = path.join(dir, `${id}-${name}`);
      fs.writeFileSync(filePath, bytes, { mode: 0o600 });
      saved.push({
        id,
        name,
        media_type: input.mediaType || "application/octet-stream",
        size: bytes.length,
        path: filePath,
      });
    }
  } catch (err) {
    // All-or-nothing: don't leave orphans from a partially saved message.
    for (const a of saved) fs.rmSync(a.path, { force: true });
    throw err;
  }
  return saved;
}

/** Remove every attachment belonging to a session (called on session delete). */
export function deleteSessionAttachments(sessionId: string): void {
  try {
    fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[attachments] Failed to remove attachments for ${sessionId}:`, err);
  }
}

/** True when `p` resolves to a location inside the attachments root. */
export function isInsideAttachmentsRoot(p: string): boolean {
  try {
    const root = fs.realpathSync(attachmentsRoot());
    const resolved = fs.realpathSync(p);
    return resolved.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

export function parseAttachments(json: string | null | undefined): MessageAttachment[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as MessageAttachment[]) : [];
  } catch {
    return [];
  }
}

/**
 * Append a note listing the attachments (with absolute paths) to the text the
 * model sees. The stored message content is left untouched — the UI renders
 * attachment chips from metadata instead.
 */
export function appendAttachmentsToPrompt(prompt: string, attachments: MessageAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return prompt;
  const lines = attachments.map(
    (a) => `- ${a.name} (${a.media_type}, ${formatSize(a.size)}): ${a.path}`
  );
  const note =
    "The user attached the following file(s) to this message. Open them with your file-reading tool using the absolute path:\n" +
    lines.join("\n");
  return prompt.trim() ? `${prompt}\n\n${note}` : note;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
