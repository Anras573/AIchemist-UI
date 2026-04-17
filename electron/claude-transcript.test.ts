// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("os", () => ({
  default: { homedir: () => "/home/user" },
  homedir: () => "/home/user",
}));

// In-memory FS shared between mock and tests.
type FakeFs = Record<string, string>;
const files: FakeFs = {};
const dirs = new Set<string>();

// Minimal fs.promises mock.
vi.mock("fs/promises", () => {
  const ENOENT = (p: string) => {
    const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    e.code = "ENOENT";
    return e;
  };
  return {
    default: {},
    stat: async (p: string) => {
      if (p in files) {
        return { size: Buffer.byteLength(files[p], "utf8"), isDirectory: () => false, mtimeMs: 1 };
      }
      if (dirs.has(p)) {
        return { size: 0, isDirectory: () => true, mtimeMs: 1 };
      }
      throw ENOENT(p);
    },
    readFile: async (p: string) => {
      if (!(p in files)) throw ENOENT(p);
      return files[p];
    },
    readdir: async (p: string) => {
      if (!dirs.has(p)) throw ENOENT(p);
      const prefix = p.endsWith("/") ? p : p + "/";
      const out = new Set<string>();
      for (const key of [...Object.keys(files), ...dirs]) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const seg = rest.split("/")[0];
          if (seg) out.add(seg);
        }
      }
      return [...out];
    },
    access: async (p: string) => {
      if (!(p in files) && !dirs.has(p)) throw ENOENT(p);
    },
    open: async (p: string) => {
      if (!(p in files)) throw ENOENT(p);
      const content = Buffer.from(files[p], "utf8");
      return {
        read: async (buf: Buffer, bufOff: number, len: number, pos: number) => {
          const slice = content.subarray(pos, pos + len);
          slice.copy(buf, bufOff);
          return { bytesRead: slice.length, buffer: buf };
        },
        close: async () => {},
      };
    },
  };
});

vi.mock("fs", () => ({
  default: {},
  watch: () => ({ close() {} }),
}));

import {
  sanitizeCwd,
  findTranscriptFile,
  parseTranscript,
  createTranscriptReader,
  transcriptToSpans,
  type TranscriptEntry,
} from "./claude-transcript";

function addDir(p: string) {
  dirs.add(p);
  // Also add all parent dirs.
  let cur = p;
  while (cur !== "/" && cur.length > 1) {
    cur = cur.replace(/\/[^/]+$/, "");
    if (cur) dirs.add(cur);
  }
}

function addFile(p: string, content: string) {
  files[p] = content;
  const parent = p.replace(/\/[^/]+$/, "");
  if (parent) addDir(parent);
}

beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k];
  dirs.clear();
  addDir("/home/user/.claude/projects");
});

const PROJECTS = "/home/user/.claude/projects";

describe("sanitizeCwd", () => {
  it("replaces slashes with dashes", () => {
    expect(sanitizeCwd("/Users/me/proj")).toBe("-Users-me-proj");
  });
  it("strips trailing slashes", () => {
    expect(sanitizeCwd("/tmp/p/")).toBe("-tmp-p");
  });
});

describe("findTranscriptFile", () => {
  it("finds the exact filename match in sanitized dir", async () => {
    const dir = `${PROJECTS}/-Users-me-proj`;
    addDir(dir);
    addFile(`${dir}/abc123.jsonl`, "");
    const found = await findTranscriptFile("/Users/me/proj", "abc123");
    expect(found).toBe(`${dir}/abc123.jsonl`);
  });

  it("falls back to content match when filename doesn't match", async () => {
    const dir = `${PROJECTS}/-Users-me-proj`;
    addDir(dir);
    addFile(
      `${dir}/other.jsonl`,
      JSON.stringify({ type: "user", sessionId: "xyz789", cwd: "/Users/me/proj" }) + "\n"
    );
    const found = await findTranscriptFile("/Users/me/proj", "xyz789");
    expect(found).toBe(`${dir}/other.jsonl`);
  });

  it("returns null when no project dir exists", async () => {
    const found = await findTranscriptFile("/nowhere", "sid");
    expect(found).toBeNull();
  });

  it("resolves project dir by scanning cwd when sanitization guess fails", async () => {
    // Realistic-ish different sanitization (e.g. Claude adds a leading `-` somewhere unusual).
    const dir = `${PROJECTS}/_weird_name_`;
    addDir(dir);
    addFile(
      `${dir}/sid.jsonl`,
      JSON.stringify({ type: "user", sessionId: "sid", cwd: "/my/cwd" }) + "\n"
    );
    const found = await findTranscriptFile("/my/cwd", "sid");
    expect(found).toBe(`${dir}/sid.jsonl`);
  });
});

describe("parseTranscript", () => {
  it("returns [] for missing file", async () => {
    expect(await parseTranscript("/nope")).toEqual([]);
  });

  it("skips malformed lines", async () => {
    addFile(
      "/t.jsonl",
      ['{"type":"user"}', "not json", '{"type":"assistant"}'].join("\n")
    );
    const entries = await parseTranscript("/t.jsonl");
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant"]);
  });
});

describe("createTranscriptReader (incremental)", () => {
  it("holds partial trailing line until newline arrives", async () => {
    addFile("/t.jsonl", '{"type":"user"}\n{"type":"ass');
    const r = createTranscriptReader("/t.jsonl");
    let res = await r.readIncremental();
    expect(res.newEntries.map((e) => e.type)).toEqual(["user"]);

    // Complete the partial line plus add another one.
    files["/t.jsonl"] = '{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n';
    res = await r.readIncremental();
    expect(res.newEntries.map((e) => e.type)).toEqual(["assistant", "user"]);
  });

  it("resets when file shrinks", async () => {
    addFile("/t.jsonl", '{"type":"user"}\n{"type":"assistant"}\n');
    const r = createTranscriptReader("/t.jsonl");
    await r.readIncremental();

    files["/t.jsonl"] = '{"type":"user"}\n';
    const res = await r.readIncremental();
    expect(res.didReset).toBe(true);
    expect(res.newEntries.map((e) => e.type)).toEqual(["user"]);
  });

  it("returns [] with no reset when nothing changed", async () => {
    addFile("/t.jsonl", '{"type":"user"}\n');
    const r = createTranscriptReader("/t.jsonl");
    await r.readIncremental();
    const res = await r.readIncremental();
    expect(res.newEntries).toEqual([]);
    expect(res.didReset).toBe(false);
  });
});

describe("transcriptToSpans", () => {
  const opts = { sessionId: "appSid", sdkSessionId: "sdkSid" };

  function mkUser(uuid: string, parentUuid: string | null, ts: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
    return {
      type: "user",
      uuid,
      parentUuid,
      timestamp: ts,
      sessionId: "sdkSid",
      message: { role: "user", content: [{ type: "text", text: "hi" }] as any },
      ...extra,
    };
  }
  function mkAssistant(
    uuid: string,
    parentUuid: string | null,
    ts: string,
    content: any[],
    usage?: any,
    extra: Partial<TranscriptEntry> = {}
  ): TranscriptEntry {
    return {
      type: "assistant",
      uuid,
      parentUuid,
      timestamp: ts,
      sessionId: "sdkSid",
      message: { role: "assistant", model: "claude-3-opus", content, usage } as any,
      ...extra,
    };
  }
  function mkToolResult(uuid: string, parentUuid: string, ts: string, toolUseId: string, content: any, isError = false): TranscriptEntry {
    return {
      type: "user",
      uuid,
      parentUuid,
      timestamp: ts,
      sessionId: "sdkSid",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content }],
      } as any,
    };
  }

  it("groups a simple turn with token summation and stable ids", () => {
    const entries = [
      mkUser("u1", null, "2025-01-01T00:00:00.000Z"),
      mkAssistant(
        "a1", "u1", "2025-01-01T00:00:01.000Z",
        [{ type: "text", text: "hello" }],
        { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }
      ),
    ];
    const spans = transcriptToSpans(entries, opts);
    expect(spans).toHaveLength(1);
    expect(spans[0].id).toBe("turn:u1");
    expect(spans[0].type).toBe("turn");
    expect((spans[0].meta as any).tokens).toEqual({ input: 10, output: 5, cacheRead: 3, cacheCreation: 2 });
    expect((spans[0].meta as any).model).toBe("claude-3-opus");

    // Re-parse is stable.
    const spans2 = transcriptToSpans([...entries], opts);
    expect(spans2[0].id).toBe(spans[0].id);
  });

  it("pairs tool_use with tool_result and sets canonical tool id", () => {
    const entries = [
      mkUser("u1", null, "2025-01-01T00:00:00.000Z"),
      mkAssistant("a1", "u1", "2025-01-01T00:00:01.000Z", [
        { type: "tool_use", id: "tu_1", name: "Read", input: { file: "x" } },
      ]),
      mkToolResult("r1", "a1", "2025-01-01T00:00:02.000Z", "tu_1", "file contents"),
    ];
    const spans = transcriptToSpans(entries, opts);
    const tool = spans.find((s) => s.type === "tool")!;
    expect(tool.id).toBe("tool:tu_1");
    expect(tool.parentId).toBe("turn:u1");
    expect(tool.status).toBe("success");
    expect((tool.meta as any).toolResult.preview).toContain("file contents");
    expect((tool.meta as any).toolUseId).toBe("tu_1");
  });

  it("marks tool status running when no tool_result present", () => {
    const entries = [
      mkUser("u1", null, "2025-01-01T00:00:00.000Z"),
      mkAssistant("a1", "u1", "2025-01-01T00:00:01.000Z", [
        { type: "tool_use", id: "tu_1", name: "Read", input: {} },
      ]),
    ];
    const spans = transcriptToSpans(entries, opts);
    const tool = spans.find((s) => s.type === "tool")!;
    expect(tool.status).toBe("running");
  });

  it("marks tool_result with is_error as error status", () => {
    const entries = [
      mkUser("u1", null, "t1"),
      mkAssistant("a1", "u1", "t2", [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }]),
      mkToolResult("r1", "a1", "t3", "tu_1", "boom", true),
    ];
    const spans = transcriptToSpans(entries, opts);
    const tool = spans.find((s) => s.type === "tool")!;
    expect(tool.status).toBe("error");
    expect((tool.meta as any).toolResult.isError).toBe(true);
  });

  it("concatenates thinking blocks into turn meta", () => {
    const entries = [
      mkUser("u1", null, "t1"),
      mkAssistant("a1", "u1", "t2", [
        { type: "thinking", thinking: "step 1" },
        { type: "text", text: "answer" },
      ]),
      mkAssistant("a2", "a1", "t3", [{ type: "thinking", thinking: "step 2" }]),
    ];
    const spans = transcriptToSpans(entries, opts);
    expect((spans[0].meta as any).thinking).toBe("step 1\n\nstep 2");
  });

  it("keeps tool-loop assistant messages in the same turn (not a new turn per tool_result)", () => {
    const entries = [
      mkUser("u1", null, "t1"),
      mkAssistant("a1", "u1", "t2", [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }]),
      mkToolResult("r1", "a1", "t3", "tu_1", "ok"),
      mkAssistant("a2", "r1", "t4", [{ type: "text", text: "done" }]),
    ];
    const spans = transcriptToSpans(entries, opts);
    const turns = spans.filter((s) => s.type === "turn");
    expect(turns).toHaveLength(1);
  });

  it("nests sidechain turns under their Task parent when unambiguous", () => {
    const entries = [
      mkUser("u1", null, "t1"),
      mkAssistant("a1", "u1", "t2", [
        { type: "tool_use", id: "task_1", name: "Task", input: {} },
      ]),
      // sub-agent work under the Task
      { ...mkUser("sub_u1", "a1", "t3"), isSidechain: true } as TranscriptEntry,
      { ...mkAssistant("sub_a1", "sub_u1", "t4", [{ type: "text", text: "sub" }]), isSidechain: true } as TranscriptEntry,
      mkToolResult("r1", "a1", "t5", "task_1", "done"),
    ];
    const spans = transcriptToSpans(entries, opts);
    const subTurn = spans.find((s) => s.id === "turn:sub_u1")!;
    expect(subTurn.parentId).toBe("tool:task_1");
    expect((subTurn.meta as any).isSidechain).toBe(true);
  });

  it("does not nest sidechain when multiple Task ancestors are ambiguous", () => {
    const entries: TranscriptEntry[] = [
      mkUser("u1", null, "t1"),
      mkAssistant("a1", "u1", "t2", [
        { type: "tool_use", id: "task_A", name: "Task", input: {} },
        { type: "tool_use", id: "task_B", name: "Task", input: {} },
      ]),
      { ...mkUser("sub_u1", "a1", "t3"), isSidechain: true },
    ];
    const spans = transcriptToSpans(entries, opts);
    const subTurn = spans.find((s) => s.id === "turn:sub_u1")!;
    expect(subTurn.parentId).toBeUndefined();
  });
});
