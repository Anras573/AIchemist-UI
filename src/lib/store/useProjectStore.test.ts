import { describe, it, expect } from "vitest";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { Project } from "@/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "My Project",
    path: "/home/user/my-project",
    created_at: "2024-01-01T00:00:00Z",
    config: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      approval_mode: "custom",
      approval_rules: [],
      custom_tools: [],
    },
    ...overrides,
  };
}

const get = () => useProjectStore.getState();

// ─── addProject / setProjects ─────────────────────────────────────────────────

describe("addProject", () => {
  it("adds a project to the list", () => {
    get().addProject(makeProject());
    expect(get().projects).toHaveLength(1);
    expect(get().projects[0].id).toBe("proj-1");
  });

  it("appends without removing existing projects", () => {
    get().addProject(makeProject({ id: "a" }));
    get().addProject(makeProject({ id: "b" }));
    expect(get().projects).toHaveLength(2);
  });
});

describe("setProjects", () => {
  it("replaces the entire projects list", () => {
    get().addProject(makeProject({ id: "old" }));
    get().setProjects([makeProject({ id: "new-1" }), makeProject({ id: "new-2" })]);
    expect(get().projects).toHaveLength(2);
    expect(get().projects.map((p) => p.id)).toEqual(["new-1", "new-2"]);
  });
});

// ─── removeProject ────────────────────────────────────────────────────────────

describe("removeProject", () => {
  it("removes the project by ID", () => {
    get().addProject(makeProject({ id: "a" }));
    get().addProject(makeProject({ id: "b" }));
    get().removeProject("a");
    expect(get().projects.map((p) => p.id)).toEqual(["b"]);
  });

  it("clears activeProjectId when the removed project was active", () => {
    get().addProject(makeProject({ id: "a" }));
    get().setActiveProject("a");
    get().removeProject("a");
    expect(get().activeProjectId).toBeNull();
  });

  it("leaves activeProjectId unchanged when removing a different project", () => {
    get().addProject(makeProject({ id: "a" }));
    get().addProject(makeProject({ id: "b" }));
    get().setActiveProject("a");
    get().removeProject("b");
    expect(get().activeProjectId).toBe("a");
  });
});

// ─── updateProject ────────────────────────────────────────────────────────────

describe("updateProject", () => {
  it("replaces the matching project in the list", () => {
    get().addProject(makeProject({ name: "Old name" }));
    get().updateProject(makeProject({ name: "New name" }));
    expect(get().projects[0].name).toBe("New name");
  });

  it("does not affect other projects", () => {
    get().addProject(makeProject({ id: "a", name: "A" }));
    get().addProject(makeProject({ id: "b", name: "B" }));
    get().updateProject(makeProject({ id: "a", name: "A updated" }));
    expect(get().projects.find((p) => p.id === "b")?.name).toBe("B");
  });
});

// ─── settings panel ───────────────────────────────────────────────────────────

describe("settings panel", () => {
  it("opens and closes", () => {
    expect(get().settingsOpen).toBe(false);
    get().openSettings();
    expect(get().settingsOpen).toBe(true);
    get().closeSettings();
    expect(get().settingsOpen).toBe(false);
  });
});
