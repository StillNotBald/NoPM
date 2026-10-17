import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as { client: unknown }).client,
}));

import { readIdempotencyKey, withIdempotency } from "./idempotency";

const A = { workspaceId: "ws-1", actorId: "usr_1", route: "POST /api/allocations" };

function req(value?: string) {
  return new Request("http://x.test/", { headers: value === undefined ? {} : { "Idempotency-Key": value } });
}

describe("readIdempotencyKey", () => {
  it("returns the trimmed key", () => expect(readIdempotencyKey(req("  abc-1.2:x_y "))).toBe("abc-1.2:x_y"));
  it("returns null when absent, empty, too long or malformed", () => {
    expect(readIdempotencyKey(req())).toBeNull();
    expect(readIdempotencyKey(req("   "))).toBeNull();
    expect(readIdempotencyKey(req("a".repeat(201)))).toBeNull();
    expect(readIdempotencyKey(req("a".repeat(200)))).toBe("a".repeat(200));
    expect(readIdempotencyKey(req("bad key!"))).toBeNull();
  });
});

describe("withIdempotency", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
    holder.db = db;
  });

  it("runs without touching the store when the key is null", async () => {
    const run = vi.fn(async () => ({ id: 1 }));
    const out = await withIdempotency({ ...A, key: null }, run);
    expect(out).toEqual({ replayed: false, result: { id: 1 } });
    expect(db.rows("idempotency_keys")).toHaveLength(0);
  });

  it("runs once and replays the stored result on a retry", async () => {
    const run = vi.fn(async () => ({ id: 7 }));
    const first = await withIdempotency({ ...A, key: "k1" }, run);
    // the fake has no column defaults; the real table stamps created_at
    for (const r of db.rows("idempotency_keys")) r.created_at = new Date().toISOString();
    const second = await withIdempotency({ ...A, key: "k1" }, run);
    expect(first).toEqual({ replayed: false, result: { id: 7 } });
    expect(second).toEqual({ replayed: true, result: { id: 7 } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("scopes by workspace, actor, route and key", async () => {
    const run = vi.fn(async () => ({ n: 1 }));
    await withIdempotency({ ...A, key: "k" }, run);
    await withIdempotency({ ...A, workspaceId: "ws-2", key: "k" }, run);
    await withIdempotency({ ...A, actorId: "usr_2", key: "k" }, run);
    await withIdempotency({ ...A, route: "other", key: "k" }, run);
    await withIdempotency({ ...A, key: "k2" }, run);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it("ignores and replaces an entry older than 24h", async () => {
    db.rows("idempotency_keys").push({
      id: "old", workspace_id: "ws-1", actor_id: "usr_1", route: A.route, key: "k",
      result: { id: "stale" }, created_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
    });
    const out = await withIdempotency({ ...A, key: "k" }, async () => ({ id: "fresh" }));
    expect(out).toEqual({ replayed: false, result: { id: "fresh" } });
    expect(db.rows("idempotency_keys").map((r) => r.id)).not.toContain("old");
  });

  it("replays the winner when the insert loses a unique-violation race", async () => {
    const winner = { id: "w", result: { id: "winner" }, created_at: new Date().toISOString() };
    let reads = 0;
    holder.db = {
      client: {
        from: () => ({
          select: () => ({
            eq() { return this; },
            maybeSingle: async () => ({ data: reads++ === 0 ? null : winner, error: null }),
          }),
          insert: async () => ({ error: { code: "23505", message: "duplicate" } }),
        }),
      },
    };
    const out = await withIdempotency({ ...A, key: "k" }, async () => ({ id: "loser" }));
    expect(out).toEqual({ replayed: true, result: { id: "winner" } });
  });

  it("still returns the result when storing it fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    holder.db = {
      client: {
        from: () => ({
          select: () => ({ eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }) }),
          insert: async () => ({ error: { message: "boom" } }),
        }),
      },
    };
    const out = await withIdempotency({ ...A, key: "k" }, async () => ({ id: 1 }));
    expect(out).toEqual({ replayed: false, result: { id: 1 } });
  });
});

describe("0067 migration text", () => {
  const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
  const sql = readFileSync(join(dir, "20261017000067_idempotency_keys.sql"), "utf8")
    .split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
  it("creates the table with FK, unique index and RLS on, no policies", () => {
    expect(sql).toMatch(/create table if not exists idempotency_keys/);
    expect(sql).toMatch(/workspace_id\s+uuid not null references workspaces\(id\)/);
    expect(sql).toMatch(/create unique index if not exists idempotency_keys_unique[\s\S]*\(workspace_id, actor_id, route, key\)/);
    expect(sql).toMatch(/alter table idempotency_keys enable row level security/);
    expect(sql).not.toMatch(/create policy/);
  });
});
