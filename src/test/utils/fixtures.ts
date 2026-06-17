import type { Message, Project, Session } from "@/types";

/**
 * Shared test fixtures for the SQLite-mirrored domain types. Centralising the
 * default shapes here means a new required field on `Session` / `Project` /
 * `Message` is a one-file change instead of a copy-paste sweep across every
 * component test.
 *
 * `makeSession` / `makeMessage` accept either a positional `id` (with optional
 * overrides) or an overrides object, so both call styles in the test suite work
 * unchanged. When an `id` is passed positionally it also seeds `title` (session)
 * to match the historical per-file helpers.
 */

function resolveOverrides<T>(
  idOrOverrides: string | Partial<T> | undefined,
  overrides: Partial<T>,
  fromId: (id: string) => Partial<T>,
): Partial<T> {
  return typeof idOrOverrides === "string"
    ? { ...fromId(idOrOverrides), ...overrides }
    : { ...(idOrOverrides ?? {}), ...overrides };
}

export function makeSession(
  idOrOverrides: string | Partial<Session> = {},
  overrides: Partial<Session> = {},
): Session {
  return {
    id: "sess-1",
    project_id: "proj-1",
    title: "Test",
    status: "idle",
    created_at: "2024-01-01T00:00:00Z",
    messages: [],
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    branch: null,
    workspace_path: null,
    agent: null,
    skills: null,
    ...resolveOverrides(idOrOverrides, overrides, (id) => ({ id, title: id })),
  };
}

export function makeMessage(
  idOrOverrides: string | Partial<Message> = {},
  overrides: Partial<Message> = {},
): Message {
  return {
    id: "m-1",
    session_id: "sess-1",
    role: "user",
    content: "content",
    tool_calls: [],
    created_at: "2024-01-01T00:00:01Z",
    ...resolveOverrides(idOrOverrides, overrides, (id) => ({ id, content: `content of ${id}` })),
  };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "My Project",
    path: "/project",
    created_at: "2024-01-01T00:00:00Z",
    config: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      approval_mode: "custom",
      approval_rules: [],
      custom_tools: [],
      allowed_tools: [],
      create_worktree_per_session: false,
    },
    ...overrides,
  };
}
