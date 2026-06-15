// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  providerSessionStore,
  parseProviderSessionState,
  _resetProviderSessionStore,
} from "./provider-session-store";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, provider_state TEXT)"
  );
  db.prepare("INSERT INTO sessions (id, provider_state) VALUES (?, NULL)").run("s1");
  return db;
}

function rawState(db: Database.Database, id: string): string | null {
  return (
    db.prepare("SELECT provider_state FROM sessions WHERE id = ?").get(id) as {
      provider_state: string | null;
    }
  ).provider_state;
}

describe("parseProviderSessionState", () => {
  it("returns an empty object for null/empty/garbage input", () => {
    expect(parseProviderSessionState(null)).toEqual({});
    expect(parseProviderSessionState("")).toEqual({});
    expect(parseProviderSessionState("not json")).toEqual({});
    expect(parseProviderSessionState("[1,2,3]")).toEqual({});
    expect(parseProviderSessionState('"a string"')).toEqual({});
  });

  it("parses a well-formed blob", () => {
    expect(parseProviderSessionState('{"claude":{"sdkSessionId":"x"}}')).toEqual({
      claude: { sdkSessionId: "x" },
    });
  });
});

describe("ProviderSessionStore", () => {
  beforeEach(() => _resetProviderSessionStore());

  it("returns undefined for an unset provider slice", () => {
    const db = makeDb();
    expect(providerSessionStore.get(db, "s1", "claude")).toBeUndefined();
  });

  it("writes a slice through to the DB and reads it back", () => {
    const db = makeDb();
    providerSessionStore.set(db, "s1", "claude", { sdkSessionId: "abc" });

    expect(providerSessionStore.get(db, "s1", "claude")).toEqual({ sdkSessionId: "abc" });
    expect(JSON.parse(rawState(db, "s1")!)).toEqual({ claude: { sdkSessionId: "abc" } });
  });

  it("keeps independent provider slices in one blob", () => {
    const db = makeDb();
    providerSessionStore.set(db, "s1", "claude", { sdkSessionId: "abc" });
    providerSessionStore.set(db, "s1", "copilot", {
      sessionId: "cop-1",
      agent: "reviewer",
      mcpFp: "fp",
    });

    expect(providerSessionStore.get(db, "s1", "claude")).toEqual({ sdkSessionId: "abc" });
    expect(providerSessionStore.get(db, "s1", "copilot")).toEqual({
      sessionId: "cop-1",
      agent: "reviewer",
      mcpFp: "fp",
    });
  });

  it("removes a slice when set to null and collapses an empty blob to NULL", () => {
    const db = makeDb();
    providerSessionStore.set(db, "s1", "claude", { sdkSessionId: "abc" });
    providerSessionStore.set(db, "s1", "claude", null);

    expect(providerSessionStore.get(db, "s1", "claude")).toBeUndefined();
    expect(rawState(db, "s1")).toBeNull();
  });

  it("seeds the read-through cache from the DB after a reset", () => {
    const db = makeDb();
    db.prepare("UPDATE sessions SET provider_state = ? WHERE id = ?").run(
      JSON.stringify({ copilot: { sessionId: "persisted" } }),
      "s1"
    );
    // Without priming the cache first, get() must read straight from the DB.
    expect(providerSessionStore.get(db, "s1", "copilot")).toEqual({ sessionId: "persisted" });
  });

  it("forget() drops the cache entry so a later read re-hits the DB", () => {
    const db = makeDb();
    providerSessionStore.set(db, "s1", "claude", { sdkSessionId: "abc" });
    // Mutate the DB out from under the cache, then forget so the next read sees it.
    db.prepare("UPDATE sessions SET provider_state = NULL WHERE id = ?").run("s1");
    providerSessionStore.forget("s1");
    expect(providerSessionStore.get(db, "s1", "claude")).toBeUndefined();
  });

  it("returns snapshots — mutating get()/set() inputs or outputs never touches the cache", () => {
    const db = makeDb();
    const input = { sdkSessionId: "abc" };
    providerSessionStore.set(db, "s1", "claude", input);
    input.sdkSessionId = "mutated-after-set";

    const out = providerSessionStore.get(db, "s1", "claude")!;
    out.sdkSessionId = "mutated-after-get";

    // Neither mutation leaked into the cache.
    expect(providerSessionStore.get(db, "s1", "claude")).toEqual({ sdkSessionId: "abc" });
  });
});
