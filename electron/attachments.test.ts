// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import RealDatabase from "better-sqlite3";
import { migrate } from "./db";
import { createSession, getSession, saveMessage, getMessageAttachments } from "./sessions";
import {
  _setAttachmentsRootForTests,
  appendAttachmentsToPrompt,
  deleteSessionAttachments,
  isInsideAttachmentsRoot,
  MAX_VISION_IMAGES,
  selectInlineImages,
  sanitizeFileName,
  saveAttachments,
} from "./attachments";

const dataUrl = (text: string, mime = "text/plain") =>
  `data:${mime};base64,${Buffer.from(text).toString("base64")}`;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aichemist-attach-"));
  _setAttachmentsRootForTests(root);
});

afterEach(() => {
  _setAttachmentsRootForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("saveAttachments", () => {
  it("writes decoded bytes under the session dir and returns metadata", () => {
    const [a] = saveAttachments("sess-1", [
      { name: "notes.txt", mediaType: "text/plain", dataUrl: dataUrl("hello") },
    ]);
    expect(a.name).toBe("notes.txt");
    expect(a.size).toBe(5);
    expect(a.path.startsWith(path.join(root, "sess-1"))).toBe(true);
    expect(fs.readFileSync(a.path, "utf8")).toBe("hello");
  });

  it("sanitizes path traversal in file names", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\evil.sh")).toBe("evil.sh");
    expect(sanitizeFileName("")).toBe("attachment");
    const [a] = saveAttachments("s", [
      { name: "../../x.txt", mediaType: "text/plain", dataUrl: dataUrl("x") },
    ]);
    expect(path.dirname(a.path)).toBe(path.join(root, "s"));
  });

  it("rejects non-base64 data URLs", () => {
    expect(() =>
      saveAttachments("s", [{ name: "a", mediaType: "text/plain", dataUrl: "data:text/plain,hi" }])
    ).toThrow(/base64/);
  });

  it("is all-or-nothing: a later failure removes earlier files", () => {
    expect(() =>
      saveAttachments("s", [
        { name: "ok.txt", mediaType: "text/plain", dataUrl: dataUrl("ok") },
        { name: "bad", mediaType: "text/plain", dataUrl: "data:nope" },
      ])
    ).toThrow();
    expect(fs.readdirSync(path.join(root, "s"))).toEqual([]);
  });

  it("deleteSessionAttachments removes the directory", () => {
    saveAttachments("s", [{ name: "a.txt", mediaType: "text/plain", dataUrl: dataUrl("a") }]);
    deleteSessionAttachments("s");
    expect(fs.existsSync(path.join(root, "s"))).toBe(false);
  });
});

describe("isInsideAttachmentsRoot", () => {
  it("accepts saved files and rejects outside paths", () => {
    const [a] = saveAttachments("s", [{ name: "a.txt", mediaType: "text/plain", dataUrl: dataUrl("a") }]);
    expect(isInsideAttachmentsRoot(a.path)).toBe(true);
    expect(isInsideAttachmentsRoot(path.join(os.tmpdir()))).toBe(false);
    expect(isInsideAttachmentsRoot("/does/not/exist")).toBe(false);
  });
});

describe("appendAttachmentsToPrompt", () => {
  it("returns the prompt unchanged without attachments", () => {
    expect(appendAttachmentsToPrompt("hi", [])).toBe("hi");
    expect(appendAttachmentsToPrompt("hi", undefined)).toBe("hi");
  });

  it("lists absolute paths after the prompt, or alone for empty text", () => {
    const att = [{ id: "1", name: "a.png", media_type: "image/png", size: 2048, path: "/x/a.png" }];
    const out = appendAttachmentsToPrompt("look", att);
    expect(out.startsWith("look\n\n")).toBe(true);
    expect(out).toContain("a.png (image/png, 2 KB): /x/a.png");
    expect(appendAttachmentsToPrompt("  ", att).startsWith("The user attached")).toBe(true);
  });
});

describe("message persistence", () => {
  it("round-trips attachments through saveMessage / getSession", () => {
    const db = new RealDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p','p','/p','now')").run();
    const session = createSession(db, "p");
    const atts = saveAttachments(session.id, [
      { name: "a.txt", mediaType: "text/plain", dataUrl: dataUrl("a") },
    ]);
    const msg = saveMessage(db, { sessionId: session.id, role: "user", content: "hi", attachments: atts });
    expect(msg.attachments).toEqual(atts);
    expect(getMessageAttachments(db, msg.id)).toEqual(atts);

    const plain = saveMessage(db, { sessionId: session.id, role: "user", content: "no files" });
    expect(plain.attachments).toBeUndefined();

    const loaded = getSession(db, session.id).messages;
    expect(loaded.find((m) => m.id === msg.id)?.attachments).toEqual(atts);
    expect(loaded.find((m) => m.id === plain.id)?.attachments).toBeUndefined();
  });
});

describe("selectInlineImages", () => {
  const png = (name: string) => {
    const [a] = saveAttachments("vis", [{ name, mediaType: "image/png", dataUrl: dataUrl(name, "image/png") }]);
    return a;
  };

  it("inlines eligible images and skips non-images", () => {
    const [txt] = saveAttachments("vis", [{ name: "a.txt", mediaType: "text/plain", dataUrl: dataUrl("a") }]);
    const img = png("one.png");
    const out = selectInlineImages([[txt, img]]);
    expect(out[0]).toEqual([
      { name: "one.png", mediaType: "image/png", base64: Buffer.from("one.png").toString("base64") },
    ]);
  });

  it("keeps only the newest MAX_VISION_IMAGES across messages", () => {
    const msgs = Array.from({ length: MAX_VISION_IMAGES + 2 }, (_, i) => [png(`img${i}.png`)]);
    const out = selectInlineImages(msgs);
    expect(out).toHaveLength(msgs.length);
    expect(out[0]).toEqual([]);
    expect(out[1]).toEqual([]);
    expect(out.slice(2).every((o) => o.length === 1)).toBe(true);
  });

  it("skips unreadable files without spending budget", () => {
    const gone = png("gone.png");
    fs.rmSync(gone.path);
    const ok = png("ok.png");
    const out = selectInlineImages([[ok], [gone]]);
    expect(out[0]).toHaveLength(1);
    expect(out[1]).toEqual([]);
  });

  it("ignores unsupported image types and oversized files", () => {
    const svg = { ...png("a.svg"), media_type: "image/svg+xml" };
    const big = { ...png("big.png"), size: 9 * 1024 * 1024 };
    expect(selectInlineImages([[svg, big]])[0]).toEqual([]);
  });
});
