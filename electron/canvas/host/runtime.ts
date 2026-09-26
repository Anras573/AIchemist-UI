/**
 * The host-side message loop (#222). Wires a loaded `CanvasServerDefinition`
 * (see `sdk.ts`) to a `HostTransport` — the pair `entry.ts` constructs from
 * `process.parentPort` in a real canvas host process, and what tests construct
 * directly to exercise this loop without spawning anything. `host-manager.ts`
 * never imports this module: it only ever talks to a host over the same
 * transport shape from the *other* end.
 */
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  type CanvasToolDescriptor,
  type HostToMainMessage,
  type MainToHostMessage,
} from "../host-protocol";
import type { CanvasServerDefinition, CanvasToolContext } from "./sdk";

export interface HostTransport {
  send(message: HostToMainMessage): void;
  /** Registers the (single) inbound message handler. */
  onMessage(handler: (message: MainToHostMessage) => void): void;
}

export interface CanvasHostRuntimeOptions {
  definition: CanvasServerDefinition;
  transport: HostTransport;
  project: { id: string; path: string };
  /** Default tool-call timeout; per-tool `timeoutMs` overrides this. */
  defaultToolTimeoutMs?: number;
}

export interface CanvasHostRuntime {
  /** Current `ctx.state` value (tests / introspection only). */
  getState(): unknown;
  /** Current revision (tests / introspection only). */
  getRevision(): number;
}

export class CanvasToolTimeoutError extends Error {
  constructor(tool: string, timeoutMs: number) {
    super(`Tool "${tool}" timed out after ${timeoutMs}ms`);
    this.name = "CanvasToolTimeoutError";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, tool: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CanvasToolTimeoutError(tool, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function toolDescriptors(definition: CanvasServerDefinition): CanvasToolDescriptor[] {
  return Object.entries(definition.tools ?? {}).map(([name, tool]) => ({
    name,
    description: tool.description,
    approval: tool.approval ?? "ask",
  }));
}

/** Builds the message loop and immediately registers it on `transport`. */
export function createCanvasHostRuntime(opts: CanvasHostRuntimeOptions): CanvasHostRuntime {
  const { definition, transport, project } = opts;
  const defaultToolTimeoutMs = opts.defaultToolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  let state: unknown = definition.initialState ?? null;
  let revision = 0;

  function emitStateChanged(): void {
    transport.send({ type: "state.changed", state, revision });
  }

  const ctx: CanvasToolContext = {
    state: {
      get: () => state,
      set: (value: unknown) => {
        state = value;
        revision += 1;
        emitStateChanged();
      },
      update: (fn: (current: unknown) => unknown) => {
        state = fn(state);
        revision += 1;
        emitStateChanged();
      },
    },
    ui: {
      send: (message: unknown) => transport.send({ type: "ui.message", message }),
    },
    agent: {
      send: async (text: string, sendOpts?: { sessionId?: string }) => {
        transport.send({ type: "agent.send", text, sessionId: sendOpts?.sessionId });
      },
    },
    project,
    log: (...args: unknown[]) => transport.send({ type: "log", level: "log", args }),
  };

  async function handleToolCall(msg: Extract<MainToHostMessage, { type: "tool.call" }>): Promise<void> {
    const tool = definition.tools?.[msg.tool];
    if (!tool) {
      transport.send({
        type: "tool.result",
        callId: msg.callId,
        ok: false,
        error: { message: `Unknown tool: ${msg.tool}` },
      });
      return;
    }

    const parsed = tool.input.safeParse(msg.args);
    if (!parsed.success) {
      transport.send({
        type: "tool.result",
        callId: msg.callId,
        ok: false,
        error: { message: `Invalid input for tool "${msg.tool}": ${parsed.error.message}` },
      });
      return;
    }

    const timeoutMs = tool.timeoutMs ?? defaultToolTimeoutMs;
    try {
      // `Promise.resolve().then(...)` also catches a handler that throws
      // synchronously, so both paths land in the same `catch` below.
      const result = await withTimeout(
        Promise.resolve().then(() => tool.handler(parsed.data, ctx)),
        timeoutMs,
        msg.tool
      );
      transport.send({ type: "tool.result", callId: msg.callId, ok: true, result });
    } catch (err) {
      transport.send({
        type: "tool.result",
        callId: msg.callId,
        ok: false,
        error: { message: errorMessage(err) },
      });
    }
  }

  transport.onMessage((msg) => {
    switch (msg.type) {
      case "init":
        state = msg.state ?? definition.initialState ?? null;
        revision = msg.revision;
        transport.send({ type: "ready", tools: toolDescriptors(definition) });
        break;
      case "tool.call":
        void handleToolCall(msg);
        break;
      case "ui.message":
        if (definition.onUiMessage) void definition.onUiMessage(msg.message, ctx);
        break;
      default:
        break;
    }
  });

  return {
    getState: () => state,
    getRevision: () => revision,
  };
}
