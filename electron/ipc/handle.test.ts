// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: handleMock } }));

import { handle } from "./handle";
import * as CH from "../ipc-channels";
import { IpcError } from "./errors";
import type { Message } from "../../src/types";

const fakeEvent = {} as Electron.IpcMainInvokeEvent;

/** Registers `handler` for `channel` and returns the wrapped fn ipcMain captured. */
function register(channel: string, handler: Parameters<typeof handle>[1]): (...a: unknown[]) => Promise<unknown> {
  handleMock.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel as any, handler as any);
  expect(handleMock).toHaveBeenCalledTimes(1);
  expect(handleMock.mock.calls[0][0]).toBe(channel);
  return handleMock.mock.calls[0][1] as (...a: unknown[]) => Promise<unknown>;
}

beforeEach(() => {
  handleMock.mockClear();
});

describe("handle — success envelope", () => {
  it("wraps a returned value in { ok: true, data }", async () => {
    const fn = register(CH.LIST_PROJECTS, () => []);
    await expect(fn(fakeEvent)).resolves.toEqual({ ok: true, data: [] });
  });

  it("wraps a void handler as { ok: true, data: undefined }", async () => {
    const fn = register(CH.UPDATE_SESSION_TITLE, () => {});
    await expect(fn(fakeEvent, "s1", "title")).resolves.toEqual({ ok: true, data: undefined });
  });

  it("awaits async handlers before wrapping", async () => {
    const fn = register(CH.GET_GIT_BRANCH, async () => "main");
    await expect(fn(fakeEvent, "/repo")).resolves.toEqual({ ok: true, data: "main" });
  });
});

describe("handle — failure envelope", () => {
  it("catches a thrown Error and classifies it", async () => {
    const fn = register(CH.GET_SESSION, () => {
      throw new Error("Session not found");
    });
    await expect(fn(fakeEvent, "missing")).resolves.toEqual({
      ok: false,
      error: { code: "not_found", message: "Session not found" },
    });
  });

  it("preserves an explicit IpcError code", async () => {
    const fn = register(CH.AGENT_SEND, () => {
      throw new IpcError("conflict", "busy");
    });
    await expect(
      fn(fakeEvent, { sessionId: "s1", prompt: "hi" })
    ).resolves.toEqual({ ok: false, error: { code: "conflict", message: "busy" } });
  });
});

describe("handle — zod validation", () => {
  it("rejects malformed mutation args before the handler runs", async () => {
    const handler = vi.fn(() => ({}) as Message);
    const fn = register(CH.SAVE_MESSAGE, handler);

    const result = (await fn(fakeEvent, { sessionId: "", role: "user" })) as {
      ok: boolean;
      error?: { code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_input");
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler when mutation args are valid", async () => {
    const handler = vi.fn(() => ({ id: "m1" }) as Message);
    const fn = register(CH.SAVE_MESSAGE, handler);

    const result = (await fn(fakeEvent, { sessionId: "s1", role: "user", content: "hello" })) as {
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});
