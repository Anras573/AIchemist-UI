// @vitest-environment node
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { stmt } from "./db-stmt-cache";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT)");
  return db;
}

describe("stmt", () => {
  it("returns a statement that works like a normal db.prepare() result", () => {
    const db = makeDb();
    stmt(db, "INSERT INTO t (id, value) VALUES (?, ?)").run("1", "hello");
    const row = stmt(db, "SELECT value FROM t WHERE id = ?").get("1") as { value: string };
    expect(row.value).toBe("hello");
  });

  it("reuses the same prepared statement instance for the same SQL text", () => {
    const db = makeDb();
    const a = stmt(db, "SELECT * FROM t WHERE id = ?");
    const b = stmt(db, "SELECT * FROM t WHERE id = ?");
    expect(a).toBe(b);
  });

  it("prepares distinct statement instances for different SQL text", () => {
    const db = makeDb();
    const a = stmt(db, "SELECT * FROM t WHERE id = ?");
    const b = stmt(db, "SELECT * FROM t WHERE value = ?");
    expect(a).not.toBe(b);
  });

  it("keeps caches isolated per Database instance", () => {
    const dbA = makeDb();
    const dbB = makeDb();
    const a = stmt(dbA, "SELECT * FROM t WHERE id = ?");
    const b = stmt(dbB, "SELECT * FROM t WHERE id = ?");
    // Same SQL text, different underlying connections — must not be shared,
    // since a Statement is bound to the Database it was prepared against.
    expect(a).not.toBe(b);
    expect(a.database).toBe(dbA);
    expect(b.database).toBe(dbB);
  });
});
