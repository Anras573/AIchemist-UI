// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}));

import { migrate } from "../db";
import { _setPricingOverridesPathForTests } from "../pricing-overrides";
import { recordUsage } from "../usage-ledger";
import { registerSpendingHandlers } from "./spending-handlers";
import * as CH from "../ipc-channels";
import type { IpcEnvelope } from "./errors";
import type { SpendingSummary } from "../../src/types/index";

let db: Database.Database;
let tempDir: string;

async function call<T>(channel: string, ...payload: unknown[]): Promise<IpcEnvelope<T>> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  return (await fn({} as unknown, ...payload)) as IpcEnvelope<T>;
}

beforeEach(() => {
  handlers.clear();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spending-handlers-"));
  _setPricingOverridesPathForTests(path.join(tempDir, "pricing-overrides.json"));

  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    "p1",
    "p1",
    "/tmp/p1",
    new Date().toISOString()
  );
  db.prepare("INSERT INTO sessions (id, project_id, title, status, created_at) VALUES (?, ?, 'S', 'idle', ?)").run(
    "s1",
    "p1",
    new Date().toISOString()
  );

  registerSpendingHandlers(db);
});

afterEach(() => {
  db.close();
  _setPricingOverridesPathForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("SPENDING_GET_SUMMARY", () => {
  it("returns an empty summary for a project with no usage", async () => {
    const env = await call<SpendingSummary>(CH.SPENDING_GET_SUMMARY, { projectId: "p1" });
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.projectId).toBe("p1");
      expect(env.data.periodSpendUSD).toBe(0);
      expect(env.data.byProvider).toEqual([]);
    }
  });

  it("reflects real usage-ledger spend, scoped to the requested project", async () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const env = await call<SpendingSummary>(CH.SPENDING_GET_SUMMARY, { projectId: "p1" });
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.periodSpendUSD).toBeGreaterThan(0);
      expect(env.data.lifetimeSpendUSD).toBe(env.data.periodSpendUSD);
      expect(env.data.byProvider).toHaveLength(1);
      expect(env.data.byProvider[0].provider).toBe("anthropic");
    }
  });

  it("honors since/until bounds passed through the IPC boundary", async () => {
    recordUsage(db, {
      sessionId: "s1",
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3-7-sonnet-20250219",
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const env = await call<SpendingSummary>(CH.SPENDING_GET_SUMMARY, {
      projectId: "p1",
      since: "2026-06-01T00:00:00.000Z",
    });
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.periodSpendUSD).toBe(0);
      expect(env.data.lifetimeSpendUSD).toBeGreaterThan(0);
    }
  });
});
