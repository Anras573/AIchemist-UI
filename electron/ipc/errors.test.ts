// @vitest-environment node
import { describe, expect, it } from "vitest";
import { IpcError, classifyError, unwrap, type IpcEnvelope } from "./errors";

describe("classifyError", () => {
  it("preserves an IpcError's explicit code and message", () => {
    expect(classifyError(new IpcError("conflict", "Session is busy"))).toEqual({
      code: "conflict",
      message: "Session is busy",
    });
  });

  it.each([
    ["Project not found: abc", "not_found"],
    ["No such session", "not_found"],
    ["Session xyz is busy — cannot queue", "conflict"],
    ["Request timed out", "timeout"],
    ["Invalid API key", "unauthorized"],
    ["GITHUB_TOKEN not configured", "unauthorized"],
    ["No window available", "unavailable"],
    ["No models available for provider", "unavailable"],
    ["Invalid name — must be a plain file name", "invalid_input"],
    ["This cannot.", "invalid_input"],
    ["operation cannot: reason", "invalid_input"],
    ["Refusing to touch agent file outside the library directories", "invalid_input"],
    ["something completely unexpected blew up", "internal"],
  ] as const)("classifies %j as %s", (message, code) => {
    expect(classifyError(new Error(message)).code).toBe(code);
  });

  it("handles non-Error throwables by stringifying them", () => {
    expect(classifyError("boom")).toEqual({ code: "internal", message: "boom" });
  });
});

describe("unwrap", () => {
  it("returns data on success", () => {
    const env: IpcEnvelope<number[]> = { ok: true, data: [1, 2, 3] };
    expect(unwrap(env)).toEqual([1, 2, 3]);
  });

  it("returns undefined data (void handlers) without throwing", () => {
    const env: IpcEnvelope<void> = { ok: true, data: undefined };
    expect(unwrap(env)).toBeUndefined();
  });

  it("throws an IpcError carrying the structured code on failure", () => {
    const env: IpcEnvelope<unknown> = { ok: false, error: { code: "not_found", message: "gone" } };
    try {
      unwrap(env);
      expect.unreachable("unwrap should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IpcError);
      expect((err as IpcError).code).toBe("not_found");
      expect((err as IpcError).message).toBe("gone");
    }
  });

  it("passes a bare (non-enveloped) value through unchanged", () => {
    expect(unwrap("legacy" as unknown as string)).toBe("legacy");
  });

  it("does not treat a domain object that merely has an `ok` key as an envelope", () => {
    // e.g. a TRACE_UNBIND-style result { ok: true } reaching unwrap directly:
    // no `data`/`error` key means it is not an envelope and must pass through.
    const domain = { ok: true } as unknown as { ok: boolean };
    expect(unwrap(domain)).toBe(domain);
  });
});
