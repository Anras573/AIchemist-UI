/**
 * `ctx.agent.send` (#228): lets a canvas's server start an agent turn in an
 * attached session ("your move", "next workflow step"). The host relays the
 * request over its message port; `CanvasHostManager` calls `send()` below and
 * turns a throw into a rejection back in the canvas.
 *
 * The turn is persisted as a user message tagged `source: "canvas:<name>"`
 * (rendered with a badge in the timeline) and delivered through
 * `enqueueTurn()`, so a busy session queues rather than races and the turn goes
 * through the normal runner.
 */
import type { Database } from "better-sqlite3";
import type { BrowserWindow } from "electron";
import * as CH from "../ipc-channels";
import { hasPendingApproval } from "../agent/approval";
import { enqueueTurn, type TurnQueueContext } from "../ipc/agent-turn-queue";
import { saveMessage } from "../sessions";
import { getCanvas } from "./store";

export const AGENT_SEND_MAX_PER_WINDOW = 5;
export const AGENT_SEND_WINDOW_MS = 60_000;
/** Safety net: an in-flight send whose turn was dropped from a cleared queue never settles. */
export const AGENT_SEND_INFLIGHT_EXPIRY_MS = 10 * 60_000;

export interface AgentBridgeOptions {
  db: Database;
  turnCtx: TurnQueueContext;
  getMainWindow?: () => BrowserWindow | null;
  now?: () => number;
}

export class AgentBridge {
  private readonly sends = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly opts: AgentBridgeOptions) {}

  /** Throws with a canvas-facing message when the send is refused. */
  send(canvasId: string, text: string, requestedSessionId?: string): void {
    const { db, turnCtx } = this.opts;
    const now = (this.opts.now ?? Date.now)();

    if (!text.trim()) throw new Error("ctx.agent.send: text must not be empty");
    const canvas = getCanvas(db, canvasId);
    if (!canvas) throw new Error("ctx.agent.send: canvas no longer exists");

    const attached = (
      db.prepare("SELECT session_id FROM session_canvases WHERE canvas_id = ? ORDER BY rowid ASC").all(canvasId) as {
        session_id: string;
      }[]
    ).map((r) => r.session_id);

    let sessionId: string;
    if (requestedSessionId !== undefined) {
      if (!attached.includes(requestedSessionId)) {
        throw new Error(`ctx.agent.send: this canvas is not attached to session "${requestedSessionId}"`);
      }
      sessionId = requestedSessionId;
    } else if (attached.length === 1) {
      sessionId = attached[0];
    } else if (attached.length === 0) {
      throw new Error("ctx.agent.send: this canvas is not attached to any session");
    } else {
      throw new Error("ctx.agent.send: canvas is attached to multiple sessions — pass { sessionId }");
    }

    if (hasPendingApproval(sessionId)) {
      throw new Error("ctx.agent.send: session is paused awaiting user approval — try again later");
    }

    const startedAt = this.inFlight.get(canvasId);
    if (startedAt !== undefined && now - startedAt < AGENT_SEND_INFLIGHT_EXPIRY_MS) {
      throw new Error("ctx.agent.send: a previous send from this canvas is still in flight");
    }
    const recent = (this.sends.get(canvasId) ?? []).filter((t) => now - t < AGENT_SEND_WINDOW_MS);
    if (recent.length >= AGENT_SEND_MAX_PER_WINDOW) {
      this.sends.set(canvasId, recent);
      throw new Error(
        `ctx.agent.send: rate limit exceeded (${AGENT_SEND_MAX_PER_WINDOW} per minute per canvas)`
      );
    }

    const message = saveMessage(db, {
      sessionId,
      role: "user",
      content: text,
      source: `canvas:${canvas.definition}`,
    });
    this.sends.set(canvasId, [...recent, now]);
    this.inFlight.set(canvasId, now);
    // Show the user message in an open timeline right away.
    this.opts.getMainWindow?.()?.webContents.send(CH.SESSION_MESSAGE, { session_id: sessionId, message });

    try {
      enqueueTurn(turnCtx, sessionId, {
        prompt: text,
        messageId: message.id,
        onSettled: () => this.inFlight.delete(canvasId),
      });
    } catch (err) {
      this.inFlight.delete(canvasId);
      throw err;
    }
  }
}
