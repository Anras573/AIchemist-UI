import { describe, it, expect, beforeEach } from "vitest";
import { useGitHubPrStore, EMPTY_PR_FORM } from "./useGitHubPrStore";

beforeEach(() => {
  useGitHubPrStore.setState({ forms: {} });
});

describe("useGitHubPrStore", () => {
  it("starts with no forms; absent sessions read as the empty form", () => {
    const { forms } = useGitHubPrStore.getState();
    expect(forms).toEqual({});
    expect(forms["missing"] ?? EMPTY_PR_FORM).toEqual(EMPTY_PR_FORM);
  });

  it("merges patches into a session's form", () => {
    const { setForm } = useGitHubPrStore.getState();
    setForm("sess-1", { isOpen: true, title: "My PR" });
    setForm("sess-1", { head: "feature/x" });

    expect(useGitHubPrStore.getState().forms["sess-1"]).toEqual({
      ...EMPTY_PR_FORM,
      isOpen: true,
      title: "My PR",
      head: "feature/x",
    });
  });

  it("keeps each session's draft isolated", () => {
    const { setForm } = useGitHubPrStore.getState();
    setForm("sess-1", { title: "One", isOpen: true });
    setForm("sess-2", { title: "Two" });

    const { forms } = useGitHubPrStore.getState();
    expect(forms["sess-1"]?.title).toBe("One");
    expect(forms["sess-1"]?.isOpen).toBe(true);
    expect(forms["sess-2"]?.title).toBe("Two");
    expect(forms["sess-2"]?.isOpen).toBe(false);
  });

  it("resetForm drops only the targeted session", () => {
    const { setForm, resetForm } = useGitHubPrStore.getState();
    setForm("sess-1", { title: "One" });
    setForm("sess-2", { title: "Two" });

    resetForm("sess-1");

    const { forms } = useGitHubPrStore.getState();
    expect(forms["sess-1"]).toBeUndefined();
    expect(forms["sess-2"]?.title).toBe("Two");
  });

  it("resetForm on an unknown session is a no-op (same state reference)", () => {
    const before = useGitHubPrStore.getState().forms;
    useGitHubPrStore.getState().resetForm("nope");
    expect(useGitHubPrStore.getState().forms).toBe(before);
  });
});
