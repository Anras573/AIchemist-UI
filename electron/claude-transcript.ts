/**
 * Claude JSONL transcript parser + live watcher.
 *
 * Claude Code writes a rich JSONL transcript per session to
 *   ~/.claude/projects/<sanitized-cwd>/<sdk-session-id>.jsonl
 *
 * Each line is a structured event (assistant message, user prompt, tool_result,
 * etc.) with timestamps, token usage, model, tool inputs, tool results,
 * thinking blocks, and sidechain flags for sub-agent work.
 *
 * This module turns those entries into enriched TraceSpans for the UI.
 *
 * Design highlights:
 *   • Canonical span ids — tool spans keyed by tool_use_id; turn spans keyed
 *     by the root user message uuid. Deterministic across reparses.
 *   • Incremental parser — keeps byte offset + partial-line buffer so a live
 *     watcher doesn't re-read the whole file on every append.
 *   • Content-based file resolution — filename lookup first, then scan the
 *     project dir and match on the `sessionId` field inside each file.
 *   • Ancestry-based sidechain grouping — sub-agent turns are nested under
 *     their parent Task tool_use only when the ancestry chain is unambiguous.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { TraceSpan } from "../src/types/index";

// ── Types ──────────────────────────────────────────────────────────────────────

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AssistantContentText { type: "text"; text?: string }
interface AssistantContentThinking { type: "thinking"; thinking?: string }
interface AssistantContentToolUse {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
}
type AssistantContent = AssistantContentText | AssistantContentThinking | AssistantContentToolUse;

interface UserContentToolResult {
  type: "tool_result";
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown; // string | Array<{ type: "text"; text: string }>
}
interface UserContentText { type: "text"; text?: string }
type UserContent = UserContentToolResult | UserContentText;

export interface TranscriptEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  gitBranch?: string;
  cwd?: string;
  sourceToolUseID?: string;
  message?: {
    role?: string;
    model?: string;
    content?: AssistantContent[] | UserContent[] | string;
    usage?: UsageBlock;
  };
  [key: string]: unknown;
}

// ── Path resolution ────────────────────────────────────────────────────────────

/** Sanitize a cwd path to Claude Code's project directory name. */
export function sanitizeCwd(cwd: string): string {
  // Claude Code replaces every non-alphanumeric character (except `-`) with `-`.
  // E.g. `/Users/me/code/My_App.v2/` → `-Users-me-code-My-App-v2`.
  // We strip trailing slashes first to keep things consistent.
  return cwd.replace(/\/+$/, "").replace(/[^a-zA-Z0-9-]/g, "-");
}

/** `~/.claude/projects` root. */
export function projectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Best-effort resolution of a project dir from cwd. If the sanitized guess
 * doesn't exist, scan the projects root for any directory whose entries
 * contain a matching `cwd` field.
 */
export async function resolveProjectDir(cwd: string): Promise<string | null> {
  const root = projectsRoot();
  const guess = path.join(root, sanitizeCwd(cwd));
  try {
    const st = await fsp.stat(guess);
    if (st.isDirectory()) return guess;
  } catch { /* fall through */ }

  // Fallback: scan all project dirs and peek at the first entry's cwd.
  let dirs: string[];
  try {
    dirs = await fsp.readdir(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const full = path.join(root, d);
    try {
      const files = await fsp.readdir(full);
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const entry = await readFirstEntry(path.join(full, f));
        if (entry?.cwd === cwd) return full;
        break; // one file is enough to identify the dir
      }
    } catch { /* skip */ }
  }
  return null;
}

async function readFirstEntry(file: string): Promise<TranscriptEntry | null> {
  try {
    const fd = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytesRead).toString("utf8");
      const nl = text.indexOf("\n");
      const line = nl >= 0 ? text.slice(0, nl) : text;
      if (!line.trim()) return null;
      return JSON.parse(line) as TranscriptEntry;
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

/**
 * Locate the transcript file for a given project + sdk session id.
 * Tries the conventional `<sessionId>.jsonl` filename first; on miss,
 * scans the project dir for a file whose first entry's `sessionId` matches.
 */
export async function findTranscriptFile(
  projectPath: string,
  sdkSessionId: string
): Promise<string | null> {
  const projectDir = await resolveProjectDir(projectPath);
  if (!projectDir) return null;

  const direct = path.join(projectDir, `${sdkSessionId}.jsonl`);
  try {
    await fsp.access(direct);
    return direct;
  } catch { /* fall through */ }

  let entries: string[];
  try { entries = await fsp.readdir(projectDir); } catch { return null; }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const first = await readFirstEntry(path.join(projectDir, f));
    if (first?.sessionId === sdkSessionId) {
      return path.join(projectDir, f);
    }
  }
  return null;
}

// ── Incremental parsing ────────────────────────────────────────────────────────

export interface TranscriptReader {
  path: string;
  /** Re-read any new bytes since the last call; returns the full entries list. */
  readAll(): Promise<TranscriptEntry[]>;
  /** Re-read only new entries since the last call. */
  readIncremental(): Promise<{ newEntries: TranscriptEntry[]; didReset: boolean }>;
  /** Reset offset + buffer (force a full re-parse next call). */
  reset(): void;
}

/** Create an incremental reader for a transcript file. */
export function createTranscriptReader(filePath: string): TranscriptReader {
  let offset = 0;
  let buffer = "";
  const entries: TranscriptEntry[] = [];

  async function pull(): Promise<{ newEntries: TranscriptEntry[]; didReset: boolean }> {
    let didReset = false;
    let size = 0;
    try { size = (await fsp.stat(filePath)).size; }
    catch { return { newEntries: [], didReset: false }; }

    if (size < offset) {
      // File was truncated / rotated — start over.
      offset = 0;
      buffer = "";
      entries.length = 0;
      didReset = true;
    }
    if (size === offset) return { newEntries: [], didReset };

    const fd = await fsp.open(filePath, "r");
    try {
      const len = size - offset;
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, offset);
      offset = size;
      buffer += buf.toString("utf8");
    } finally {
      await fd.close();
    }

    const lines = buffer.split("\n");
    // Last element is the (possibly empty) trailing partial — keep it for next call.
    buffer = lines.pop() ?? "";
    const newOnes: TranscriptEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        newOnes.push(JSON.parse(line) as TranscriptEntry);
      } catch { /* skip malformed line */ }
    }
    entries.push(...newOnes);
    return { newEntries: newOnes, didReset };
  }

  return {
    path: filePath,
    async readAll() {
      await pull();
      return [...entries];
    },
    async readIncremental() {
      return pull();
    },
    reset() {
      offset = 0;
      buffer = "";
      entries.length = 0;
    },
  };
}

/** One-shot parse for tests / GET_TRACES — no incremental state kept. */
export async function parseTranscript(filePath: string): Promise<TranscriptEntry[]> {
  let raw: string;
  try { raw = await fsp.readFile(filePath, "utf8"); }
  catch { return []; }
  const out: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as TranscriptEntry); }
    catch { /* skip */ }
  }
  return out;
}

// ── Spans synthesis ────────────────────────────────────────────────────────────

export interface TranscriptSpanOptions {
  sessionId: string;     // app session id (owns the spans)
  sdkSessionId: string;  // sdk session id (used only for consistency checks)
}

interface BuildCtx {
  byUuid: Map<string, TranscriptEntry>;
  toolUseByEntry: Map<string, { toolUseId: string; name: string }[]>;
}

function extractAssistantContent(e: TranscriptEntry): AssistantContent[] {
  const c = e.message?.content;
  return Array.isArray(c) ? (c as AssistantContent[]) : [];
}

function extractUserContent(e: TranscriptEntry): UserContent[] {
  const c = e.message?.content;
  return Array.isArray(c) ? (c as UserContent[]) : [];
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => {
        if (typeof b === "string") return b;
        const block = b as { type?: string; text?: string };
        return block.text ?? "";
      })
      .join("\n");
  }
  return "";
}

function truncatePreview(s: string, lines = 5, maxLen = 800): string {
  const split = s.split("\n");
  const head = split.slice(0, lines).join("\n");
  const omitted = split.length - lines;
  const trimmed = head.length > maxLen ? head.slice(0, maxLen) + "…" : head;
  return omitted > 0 ? `${trimmed}\n… (+${omitted} more lines)` : trimmed;
}

/** Walk the parentUuid chain and return all ancestors (nearest first). */
function ancestorsOf(e: TranscriptEntry, byUuid: Map<string, TranscriptEntry>): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let cur = e.parentUuid ? byUuid.get(e.parentUuid) : undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.uuid ?? "")) {
    if (cur.uuid) seen.add(cur.uuid);
    out.push(cur);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }
  return out;
}

/**
 * Determine whether a sidechain entry has a unique Task tool_use ancestor.
 * Returns the tool_use_id when unambiguous, otherwise null.
 */
function findSidechainParentTaskToolUseId(
  e: TranscriptEntry,
  ctx: BuildCtx
): string | null {
  const chain = ancestorsOf(e, ctx.byUuid);
  const candidates: string[] = [];
  for (const anc of chain) {
    if (anc.isSidechain) continue;
    const uses = ctx.toolUseByEntry.get(anc.uuid ?? "") ?? [];
    for (const u of uses) {
      if (u.name === "Task" || u.name === "Agent") candidates.push(u.toolUseId);
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export interface ClaudeSpanAccumulator {
  /**
   * Fold newly-read transcript entries into the running turn/tool state and
   * return the full, up-to-date span list. Only `newEntries` are walked —
   * spans for turns untouched by this batch are reused as-is rather than
   * rebuilt, which is what keeps a long-lived session's live-watcher refresh
   * cost bounded by the size of each update instead of the whole transcript
   * (issue #207).
   */
  applyEntries(newEntries: TranscriptEntry[]): TraceSpan[];
}

interface TurnState {
  id: string;                        // canonical turn span id
  anchor: TranscriptEntry;           // the root user prompt
  startMs: number;
  assistants: TranscriptEntry[];     // assistant messages in this turn
  tools: { toolUseId: string; name: string; input: unknown; startEntry: TranscriptEntry }[];
  sidechain: boolean;
}

/**
 * Stateful, incremental span builder for a Claude transcript. Create one per
 * watched session and keep feeding it newly-read entries (not the full
 * cumulative list) on each refresh.
 *
 * Turns are anchored at root (non-sidechain, non-meta) user prompts that
 * aren't tool_result deliveries; all subsequent assistant + tool_result
 * entries belong to that turn until the next root user prompt.
 *
 * Sidechain turns use the same grouping logic but start at sidechain user
 * entries; they're nested under their parent Task tool span when unambiguous.
 */
export function createClaudeSpanAccumulator(opts: TranscriptSpanOptions): ClaudeSpanAccumulator {
  const { sessionId, sdkSessionId } = opts;

  // Cumulative indexes, grown incrementally across calls.
  const byUuid = new Map<string, TranscriptEntry>();
  const toolUseByEntry = new Map<string, { toolUseId: string; name: string }[]>();
  const ctx: BuildCtx = { byUuid, toolUseByEntry };
  const toolResultById = new Map<string, { entry: TranscriptEntry; block: UserContentToolResult }>();
  const toolOwnerTurnId = new Map<string, string>(); // tool_use_id → owning turn id

  const turnOrder: string[] = [];
  const turnsById = new Map<string, TurnState>();
  const spanById = new Map<string, TraceSpan>();
  let current: TurnState | null = null;

  const startNewTurn = (anchor: TranscriptEntry, sidechain: boolean): TurnState => {
    const startMs = anchor.timestamp ? Date.parse(anchor.timestamp) : 0;
    const id = anchor.uuid ? `turn:${anchor.uuid}` : `turn:${sdkSessionId}:${startMs}`;
    const t: TurnState = { id, anchor, startMs, assistants: [], tools: [], sidechain };
    turnsById.set(id, t);
    turnOrder.push(id);
    current = t;
    return t;
  };

  const rebuildTurnSpans = (t: TurnState): void => {
    const anchor = t.anchor;
    const lastEntry = t.assistants[t.assistants.length - 1] ?? anchor;
    // Turn end = timestamp of the last tool_result in this turn OR last assistant msg.
    let endMs = lastEntry.timestamp ? Date.parse(lastEntry.timestamp) : t.startMs;
    for (const tool of t.tools) {
      const res = toolResultById.get(tool.toolUseId);
      const ts = res?.entry.timestamp ? Date.parse(res.entry.timestamp) : undefined;
      if (ts && ts > endMs) endMs = ts;
    }

    // Sum tokens across assistant messages.
    let tokIn = 0, tokOut = 0, tokCacheR = 0, tokCacheC = 0;
    let model: string | undefined;
    let thinking = "";
    for (const a of t.assistants) {
      const u = a.message?.usage;
      if (u) {
        tokIn += u.input_tokens ?? 0;
        tokOut += u.output_tokens ?? 0;
        tokCacheR += u.cache_read_input_tokens ?? 0;
        tokCacheC += u.cache_creation_input_tokens ?? 0;
      }
      if (!model && a.message?.model) model = a.message.model;
      for (const b of extractAssistantContent(a)) {
        if (b.type === "thinking" && b.thinking) {
          thinking += (thinking ? "\n\n" : "") + b.thinking;
        }
      }
    }

    // Determine parent for sidechain turns.
    let parentToolSpanId: string | undefined;
    if (t.sidechain) {
      const parentToolUseId = findSidechainParentTaskToolUseId(anchor, ctx);
      if (parentToolUseId) parentToolSpanId = `tool:${parentToolUseId}`;
    }

    const turnName = t.sidechain ? "Sub-agent turn" : "Agent Turn";
    spanById.set(t.id, {
      id: t.id,
      parentId: parentToolSpanId,
      sessionId,
      type: "turn",
      name: turnName,
      startMs: t.startMs,
      endMs,
      durationMs: Math.max(0, endMs - t.startMs),
      status: "success",
      meta: {
        model,
        tokens: { input: tokIn, output: tokOut, cacheRead: tokCacheR, cacheCreation: tokCacheC },
        thinking: thinking || undefined,
        isSidechain: t.sidechain || undefined,
        gitBranch: anchor.gitBranch,
        rootUserUuid: anchor.uuid,
      },
    });

    // Tool spans under this turn.
    for (const tool of t.tools) {
      const res = toolResultById.get(tool.toolUseId);
      const toolStart = tool.startEntry.timestamp ? Date.parse(tool.startEntry.timestamp) : t.startMs;
      const toolEnd = res?.entry.timestamp ? Date.parse(res.entry.timestamp) : undefined;
      const previewText = res ? extractToolResultText(res.block.content) : "";
      const isError = !!res?.block.is_error;

      spanById.set(`tool:${tool.toolUseId}`, {
        id: `tool:${tool.toolUseId}`,
        parentId: t.id,
        sessionId,
        type: "tool",
        name: tool.name,
        startMs: toolStart,
        endMs: toolEnd,
        durationMs: toolEnd !== undefined ? Math.max(0, toolEnd - toolStart) : undefined,
        status: res ? (isError ? "error" : "success") : "running",
        meta: {
          input: tool.input,
          toolUseId: tool.toolUseId,
          toolResult: res
            ? { preview: truncatePreview(previewText), isError }
            : undefined,
        },
      });
    }
  };

  return {
    applyEntries(newEntries) {
      // Index pass — grows the cumulative uuid / tool_use lookups.
      for (const e of newEntries) {
        if (e.uuid) byUuid.set(e.uuid, e);
        if (e.type === "assistant") {
          const blocks = extractAssistantContent(e);
          const uses: { toolUseId: string; name: string }[] = [];
          for (const b of blocks) {
            if (b.type === "tool_use" && b.id && b.name) {
              uses.push({ toolUseId: b.id, name: b.name });
            }
          }
          if (uses.length) toolUseByEntry.set(e.uuid ?? "", uses);
        }
      }

      // Grouping pass — only over the new entries; turns from prior batches
      // are left untouched unless a new tool_result targets one of them.
      const dirty = new Set<string>();

      for (const e of newEntries) {
        if (e.type === "user") {
          const blocks = extractUserContent(e);
          const isToolResult = blocks.some((b) => b.type === "tool_result");
          if (isToolResult) {
            for (const b of blocks) {
              if (b.type === "tool_result" && b.tool_use_id) {
                toolResultById.set(b.tool_use_id, { entry: e, block: b });
                const ownerId = toolOwnerTurnId.get(b.tool_use_id);
                if (ownerId) dirty.add(ownerId);
              }
            }
            continue;
          }
          if (!e.isMeta) {
            dirty.add(startNewTurn(e, !!e.isSidechain).id);
          }
          continue;
        }
        if (e.type === "assistant") {
          if (!current) {
            // Orphan assistant — synthesize an anchor so we don't drop it.
            dirty.add(startNewTurn(e, !!e.isSidechain).id);
          }
          current!.assistants.push(e);
          dirty.add(current!.id);
          for (const use of toolUseByEntry.get(e.uuid ?? "") ?? []) {
            const block = extractAssistantContent(e).find(
              (b) => b.type === "tool_use" && (b as AssistantContentToolUse).id === use.toolUseId
            ) as AssistantContentToolUse | undefined;
            current!.tools.push({
              toolUseId: use.toolUseId,
              name: use.name,
              input: block?.input ?? {},
              startEntry: e,
            });
            toolOwnerTurnId.set(use.toolUseId, current!.id);
          }
        }
      }

      for (const id of dirty) {
        const t = turnsById.get(id);
        if (t) rebuildTurnSpans(t);
      }

      // Flatten in turn-start order (mirrors the original full-rebuild order).
      const spans: TraceSpan[] = [];
      for (const id of turnOrder) {
        const t = turnsById.get(id)!;
        spans.push(spanById.get(id)!);
        for (const tool of t.tools) {
          spans.push(spanById.get(`tool:${tool.toolUseId}`)!);
        }
      }
      return spans;
    },
  };
}

/**
 * Build TraceSpans from transcript entries.
 *
 * One-shot wrapper over `createClaudeSpanAccumulator` for callers (tests,
 * `GET_TRACES`, usage-ledger backfill) that just want a full parse and don't
 * need to keep state between calls.
 */
export function transcriptToSpans(
  entries: TranscriptEntry[],
  opts: TranscriptSpanOptions
): TraceSpan[] {
  return createClaudeSpanAccumulator(opts).applyEntries(entries);
}

// ── Watcher ────────────────────────────────────────────────────────────────────

export interface TranscriptWatcher {
  close(): void;
}

export interface WatchCallbacks {
  onUpdate: (spans: TraceSpan[]) => void;
  onError?: (err: unknown) => void;
}

/**
 * Watch a project's transcript directory for updates to the target jsonl.
 * Emits the full enriched span list on every change (debounced 100ms).
 *
 * We watch the directory rather than the file directly so we can still pick
 * up the file appearing later (e.g. session just created) or rotating after
 * a resume.
 */
export function watchTranscript(
  projectPath: string,
  sdkSessionId: string,
  sessionId: string,
  cb: WatchCallbacks
): TranscriptWatcher {
  let closed = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let reader: TranscriptReader | null = null;
  let resolvedPath: string | null = null;
  let watcher: fs.FSWatcher | null = null;
  let stat0: number | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let lastEmit = 0;
  let accumulator = createClaudeSpanAccumulator({ sessionId, sdkSessionId });

  const schedule = () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 100);
  };

  const refresh = async () => {
    if (closed) return;
    try {
      if (!resolvedPath) {
        resolvedPath = await findTranscriptFile(projectPath, sdkSessionId);
        if (!resolvedPath) return;
        reader = createTranscriptReader(resolvedPath);
      }
      // Incremental read — only appended bytes are parsed per change, and
      // only the new entries (not the whole cumulative history) are folded
      // into the span accumulator (issue #207).
      const { newEntries, didReset } = await reader!.readIncremental();
      if (didReset) accumulator = createClaudeSpanAccumulator({ sessionId, sdkSessionId });
      if (newEntries.length === 0 && !didReset) return;
      const spans = accumulator.applyEntries(newEntries);
      lastEmit = Date.now();
      cb.onUpdate(spans);
    } catch (err) {
      cb.onError?.(err);
    }
  };

  const startWatcher = async () => {
    const root = await resolveProjectDir(projectPath);
    const target = root ?? projectsRoot();
    try {
      watcher = fs.watch(target, { persistent: false }, (_event, fname) => {
        // Filter to jsonl files — resolved path may not be known yet.
        if (fname && !String(fname).endsWith(".jsonl")) return;
        schedule();
      });
    } catch { /* best effort */ }

    // macOS fs.watch safety-net: stat-poll the resolved file every 1s, and
    // emit if mtime changed without a fs.watch event in the last 2s.
    pollTimer = setInterval(async () => {
      if (closed || !resolvedPath) return;
      try {
        const st = await fsp.stat(resolvedPath);
        if (stat0 === null) { stat0 = st.mtimeMs; return; }
        if (st.mtimeMs !== stat0) {
          stat0 = st.mtimeMs;
          if (Date.now() - lastEmit > 500) schedule();
        }
      } catch { /* file may not exist yet */ }
    }, 1000);
  };

  // Kick everything off.
  void refresh().then(startWatcher);

  return {
    close() {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    },
  };
}
