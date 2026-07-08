import * as CH from "../ipc-channels";
import type {
  CompactionEvent,
  Message,
  FileChange,
  SessionStatus,
  SessionUsage,
} from "../../src/types/index";

const ZERO_USAGE: SessionUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/**
 * Last usage reading per session, keyed by `sessionId` (same "keyed map"
 * pattern as the approval/question promise maps). Each provider constructs
 * its own `TurnEmitter` instance from `webContents`/`sessionId` rather than
 * sharing the runner's, so per-instance state wouldn't be visible to the
 * runner — a session-keyed store is the seam every instance actually shares.
 * `usage()` is called repeatedly as a turn streams (each call carries the
 * running total, not a delta), so by the time the turn completes this holds
 * its final totals; the runner reads it post-turn to write the usage-ledger
 * row, then clears it.
 */
const lastUsageBySession = new Map<string, SessionUsage>();

/** The last usage reading recorded for `sessionId` (all zeros if `usage()` was never called this turn). */
export function getLastUsage(sessionId: string): SessionUsage {
  return lastUsageBySession.get(sessionId) ?? ZERO_USAGE;
}

/** Drop the tracked usage reading for `sessionId`. Call after consuming it, and before starting a new turn. */
export function clearLastUsage(sessionId: string): void {
  lastUsageBySession.delete(sessionId);
}

/**
 * Typed wrapper around `webContents.send` for the SESSION_* push events a
 * provider emits during an agent turn.
 *
 * Every provider streams through the same emitter so event payload shapes are
 * defined in exactly one place, and tests can observe a single seam instead of
 * matching raw channel/payload pairs per provider.
 */
export class TurnEmitter {
  constructor(
    /**
     * The underlying webContents, exposed for subsystems that own their own
     * channels (approval and question prompts). Provider code should emit
     * through the typed methods, never via `webContents.send` directly.
     */
    readonly webContents: Electron.WebContents,
    readonly sessionId: string,
  ) {}

  /** Streamed assistant text (SESSION_DELTA). */
  delta(text: string): void {
    this.webContents.send(CH.SESSION_DELTA, {
      session_id: this.sessionId,
      text_delta: text,
    });
  }

  /** Streamed extended-thinking text (SESSION_THINKING_DELTA). */
  thinkingDelta(text: string): void {
    this.webContents.send(CH.SESSION_THINKING_DELTA, {
      session_id: this.sessionId,
      text_delta: text,
    });
  }

  /** Extended thinking finished (SESSION_THINKING_DONE). */
  thinkingDone(): void {
    this.webContents.send(CH.SESSION_THINKING_DONE, { session_id: this.sessionId });
  }

  /** Token usage update for the current turn (SESSION_USAGE). */
  usage(usage: SessionUsage): void {
    lastUsageBySession.set(this.sessionId, usage);
    this.webContents.send(CH.SESSION_USAGE, { session_id: this.sessionId, usage });
  }

  /** A tool call has started (SESSION_TOOL_CALL). */
  toolCall(toolCallId: string, toolName: string, input: unknown): void {
    this.webContents.send(CH.SESSION_TOOL_CALL, {
      session_id: this.sessionId,
      tool_name: toolName,
      tool_call_id: toolCallId,
      input,
    });
  }

  /** A tool call has produced output (SESSION_TOOL_RESULT). */
  toolResult(toolName: string, output: unknown): void {
    this.webContents.send(CH.SESSION_TOOL_RESULT, {
      session_id: this.sessionId,
      tool_name: toolName,
      output,
    });
  }

  /** A file was written or deleted by a tool (SESSION_FILE_CHANGE). */
  fileChange(change: FileChange): void {
    this.webContents.send(CH.SESSION_FILE_CHANGE, {
      session_id: this.sessionId,
      file_change: change,
    });
  }

  /** A context compaction boundary was crossed (SESSION_COMPACTION). */
  compaction(compaction: Omit<CompactionEvent, "session_id">): void {
    this.webContents.send(CH.SESSION_COMPACTION, {
      session_id: this.sessionId,
      compaction: { ...compaction, session_id: this.sessionId },
    });
  }

  /** Session status transition (SESSION_STATUS). */
  status(status: SessionStatus | "complete"): void {
    this.webContents.send(CH.SESSION_STATUS, {
      session_id: this.sessionId,
      status,
    });
  }

  /** Final persisted assistant message for the turn (SESSION_MESSAGE). */
  message(message: Message): void {
    this.webContents.send(CH.SESSION_MESSAGE, {
      session_id: this.sessionId,
      message,
    });
  }

  /**
   * Derived emitter whose `delta()` is a no-op. Used for delegated sub-agent
   * turns whose streaming text must not interleave with the orchestrator's
   * streaming bubble; all other events still pass through.
   */
  withoutDeltas(): TurnEmitter {
    return new SilentDeltaEmitter(this.webContents, this.sessionId);
  }
}

class SilentDeltaEmitter extends TurnEmitter {
  override delta(): void {}
}

/**
 * Emit and return a user-visible notice that a self-driven provider's
 * in-process tool loop was stopped at its configured round cap
 * (`AICHEMIST_MAX_TOOL_ROUNDS`). Shared by the Ollama and OpenAI-compatible
 * providers so the phrasing stays consistent. The returned text is appended to
 * the turn's persisted content so the truncation survives in history, while
 * the `delta()` surfaces it live in the streaming bubble.
 */
export function emitToolRoundLimitNotice(emitter: TurnEmitter, maxRounds: number): string {
  const notice =
    `\n\n_Reached the tool-round limit (${maxRounds}). The turn was stopped before the ` +
    `model finished — raise "Max tool rounds" in Settings → Defaults if you need longer runs._`;
  emitter.delta(notice);
  return notice;
}
