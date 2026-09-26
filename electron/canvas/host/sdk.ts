/**
 * The canvas server SDK (#222) — resolvable by canvas `server.mjs` modules as
 * `@aichemist/canvas` (see `loader-hook.ts`). Deliberately tiny: `defineCanvas`
 * is an identity function that exists only to give authors type-checking and
 * autocomplete, and `ctx` is implemented by `../runtime.ts` against whichever
 * definition this produces — nothing here talks to a `MessagePort` directly.
 */
import { z } from "zod";

export { z };

export type CanvasApproval = "none" | "ask";

/** Passed to every tool handler and to `onUiMessage`. */
export interface CanvasToolContext {
  state: {
    get(): unknown;
    set(value: unknown): void;
    update(fn: (current: unknown) => unknown): void;
  };
  /** Push an arbitrary message to the UI, beyond state sync. */
  ui: {
    send(message: unknown): void;
  };
  /** Send a message into an attached session, starting (or queueing) a turn. */
  agent: {
    send(text: string, opts?: { sessionId?: string }): Promise<void>;
  };
  project: { id: string; path: string };
  log: (...args: unknown[]) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tool's input/result types are erased once stored in `CanvasServerDefinition.tools`; each handler is still fully typed at its own call site.
export interface CanvasTool<TInput = any, TResult = unknown> {
  description: string;
  input: z.ZodType<TInput>;
  /** Whether a call needs user approval before running. Defaults to `"ask"`. */
  approval?: CanvasApproval;
  /** Overrides the host's default tool-call timeout (60s) for this tool. */
  timeoutMs?: number;
  handler(args: TInput, ctx: CanvasToolContext): TResult | Promise<TResult>;
}

export interface CanvasServerDefinition {
  /** Seeds `ctx.state` for a brand-new instance (ignored once one is persisted). */
  initialState?: unknown;
  tools?: Record<string, CanvasTool>;
  /** Messages from the UI (button clicks, drags, form submits). */
  onUiMessage?(message: unknown, ctx: CanvasToolContext): void | Promise<void>;
}

/** Identity helper — exists purely so `server.mjs` authors get type inference. */
export function defineCanvas(definition: CanvasServerDefinition): CanvasServerDefinition {
  return definition;
}
