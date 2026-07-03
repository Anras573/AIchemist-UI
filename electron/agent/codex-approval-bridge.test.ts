// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// The bridge calls the real approval gate; drive it through mocks so we can
// assert routing (trusted → no prompt; prompt → decision) without a renderer.
const { requiresApprovalMock, requestApprovalMock } = vi.hoisted(() => ({
  requiresApprovalMock: vi.fn(),
  requestApprovalMock: vi.fn(),
}));
vi.mock("./approval", () => ({
  requiresApproval: requiresApprovalMock,
  requestApproval: requestApprovalMock,
}));

import { resolveCodexApproval, type CodexApprovalContext } from "./codex-approval-bridge";

const ctx: CodexApprovalContext = {
  sessionId: "s1",
  config: {} as any,
  webContents: { send: vi.fn() } as any,
  nonInteractive: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveCodexApproval — command execution", () => {
  const req = (command: unknown) => ({
    method: "item/commandExecution/requestApproval",
    params: { threadId: "t", command },
  });

  it("auto-allows a trusted command without prompting", async () => {
    requiresApprovalMock.mockReturnValue(false);
    const res = await resolveCodexApproval(req("ls"), ctx);
    expect(res).toEqual({ decision: "approved" });
    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(requiresApprovalMock).toHaveBeenCalledWith("s1", ctx.config, "shell", "execute_bash", { command: "ls" });
  });

  it("prompts and maps an allow to decision approved", async () => {
    requiresApprovalMock.mockReturnValue(true);
    requestApprovalMock.mockResolvedValue(true);
    const res = await resolveCodexApproval(req("rm -rf x"), ctx);
    expect(res).toEqual({ decision: "approved" });
    expect(requestApprovalMock).toHaveBeenCalledWith(ctx.webContents, "s1", "execute_bash", { command: "rm -rf x" }, {
      nonInteractive: false,
    });
  });

  it("maps a denied prompt to decision denied", async () => {
    requiresApprovalMock.mockReturnValue(true);
    requestApprovalMock.mockResolvedValue(false);
    expect(await resolveCodexApproval(req("curl x"), ctx)).toEqual({ decision: "denied" });
  });

  it("joins an argv-array command and still gates it", async () => {
    requiresApprovalMock.mockReturnValue(true);
    requestApprovalMock.mockResolvedValue(true);
    await resolveCodexApproval(req(["git", "push", "--force"]), ctx);
    expect(requestApprovalMock).toHaveBeenCalledWith(
      ctx.webContents,
      "s1",
      "execute_bash",
      { command: "git push --force" },
      { nonInteractive: false },
    );
  });

  it("extracts a command nested under commandExecution", async () => {
    requiresApprovalMock.mockReturnValue(false);
    await resolveCodexApproval(
      { method: "item/commandExecution/requestApproval", params: { commandExecution: { command: "make" } } },
      ctx,
    );
    expect(requiresApprovalMock).toHaveBeenCalledWith("s1", ctx.config, "shell", "execute_bash", { command: "make" });
  });
});

describe("resolveCodexApproval — permissions", () => {
  const req = (write: string[]) => ({
    method: "item/permissions/requestApproval",
    params: { permissions: { fileSystem: { write } } },
  });

  it("grants the full requested subset on allow", async () => {
    requiresApprovalMock.mockReturnValue(true);
    requestApprovalMock.mockResolvedValue(true);
    const res = await resolveCodexApproval(req(["/proj/a", "/proj/b"]), ctx);
    expect(res).toEqual({ scope: "turn", permissions: { fileSystem: { write: ["/proj/a", "/proj/b"] } } });
    expect(requestApprovalMock).toHaveBeenCalledWith(
      ctx.webContents,
      "s1",
      "write_file",
      { paths: ["/proj/a", "/proj/b"] },
      { nonInteractive: false },
    );
  });

  it("grants none on deny", async () => {
    requiresApprovalMock.mockReturnValue(true);
    requestApprovalMock.mockResolvedValue(false);
    const res = await resolveCodexApproval(req(["/proj/a"]), ctx);
    expect(res).toEqual({ scope: "turn", permissions: { fileSystem: { write: [] } } });
  });

  it("grants the full subset without prompting when filesystem isn't gated", async () => {
    requiresApprovalMock.mockReturnValue(false);
    const res = await resolveCodexApproval(req(["/proj/a"]), ctx);
    expect(res).toEqual({ scope: "turn", permissions: { fileSystem: { write: ["/proj/a"] } } });
    expect(requestApprovalMock).not.toHaveBeenCalled();
  });
});

describe("resolveCodexApproval — unknown", () => {
  it("denies an unrecognized approval request", async () => {
    const res = await resolveCodexApproval({ method: "item/somethingElse/requestApproval", params: {} }, ctx);
    expect(res).toEqual({ decision: "denied" });
    expect(requestApprovalMock).not.toHaveBeenCalled();
  });
});
