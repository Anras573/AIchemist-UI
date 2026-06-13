import { describe, expect, it } from "vitest";
import { ipcErrorCode, IpcError } from "./ipc";

describe("ipcErrorCode", () => {
  it("reads the code off an IpcError", () => {
    expect(ipcErrorCode(new IpcError("conflict", "busy"))).toBe("conflict");
  });

  it("reads the code off a plain object that lost its prototype across the bridge", () => {
    // contextBridge may deliver a plain Error-like object without the IpcError
    // prototype — the helper must still recover the code from the `code` field.
    const reconstructed = Object.assign(new Error("gone"), { code: "not_found" });
    expect(ipcErrorCode(reconstructed)).toBe("not_found");
  });

  it("returns undefined for a non-coded error", () => {
    expect(ipcErrorCode(new Error("boom"))).toBeUndefined();
  });

  it("returns undefined for non-object throwables and a non-string code", () => {
    expect(ipcErrorCode("boom")).toBeUndefined();
    expect(ipcErrorCode({ code: 42 })).toBeUndefined();
  });
});
