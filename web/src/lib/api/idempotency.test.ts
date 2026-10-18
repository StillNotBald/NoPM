import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

/** Minimal idempotency_keys store with the real unique index on (workspace, actor, route, key). */
class Store {
  rows: Row[] = [];
  seq = 0;
  failInsert: { code?: string; message: string } | null = null;
  client = { from: () => new Q(this) };
}
class Q {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private filters: ((r: Row) => boolean)[] = [];
  private payload: Row = {};
  constructor(private s: Store) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  insert(p: Row) { this.op = "insert"; this.payload = p; return this; }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  maybeSingle() { return this.run().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })); }
  then<A, B>(a?: (v: { data: unknown; error: unknown }) => A, b?: (e: unknown) => B) { return this.run().then(a, b); }
  private async run(): Promise<{ data: unknown; error: unknown }> {
    const s = this.s;
    const match = (r: Row) => this.filters.every((f) => f(r));
    if (this.op === "insert") {
      if (s.failInsert) return { data: null, error: s.failInsert };
      const p = this.payload;
      if (s.rows.some((r) => ["workspace_id", "actor_id", "route", "key"].every((c) => r[c] === p[c]))) {
        return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      const row = { id: `id-${++s.seq}`, ...p };
      s.rows.push(row);
      return { data: [{ ...row }], error: null };
    }
    if (this.op === "update") {
      const hit = s.rows.filter(match);
      for (const r of hit) Object.assign(r, this.payload);
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
    if (this.op === "delete") {
      s.rows = s.rows.filter((r) => !match(r));
      return { data: null, error: null };
    }
    return { data: s.rows.filter(match).map((r) => ({ ...r })), error: null };
  }
}

const holder = vi.hoisted(() => ({ store: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.store as { client: unknown }).client,
}));

import { hashRequestBody, readIdempotencyKey, withIdempotency } from "./idempotency";

const A = { workspaceId: "ws-1", actorId: "usr_1", route: "POST /api/allocations" };

function req(value?: string) {
  return new Request("http://x.test/", { headers: value === undefined ? {} : { "Idempotency-Key": value } });
}

describe("readIdempotencyKey", () => {
  it("returns the trimmed key", () => expect(readIdempotencyKey(req("  abc-1.2:x_y "))).toBe("abc-1.2:x_y"));
  it("returns null when the header is absent", () => expect(readIdempotencyKey(req())).toBeNull());
  it("answers 400 for a present but empty, too long or malformed key", () => {
    for (const bad of ["   ", "a".repeat(201), "bad key!"]) {
      expect(() => readIdempotencyKey(req(bad))).toThrowError(
        expect.objectContaining({ status: 400, code: "invalid_idempotency_key" }),
      );
    }
    expect(readIdempotencyKey(req("a".repeat(200)))).toBe("a".repeat(200));
  });
});

describe("withIdempotency", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store();
    holder.store = store;
    vi.restoreAllMocks();
  });

  it("runs without touching the store when the key is null", async () => {
    const run = vi.fn(async () => ({ id: 1 }));
    expect(await withIdempotency({ ...A, key: null }, run)).toEqual({ replayed: false, result: { id: 1 } });
    expect(store.rows).toHaveLength(0);
  });

  it("reserves, runs once, marks done and replays on a retry", async () => {
    const run = vi.fn(async () => ({ id: 7 }));
    const first = await withIdempotency({ ...A, key: "k1" }, run);
    expect(store.rows[0]).toMatchObject({ status: "done", result: { id: 7 } });
    const second = await withIdempotency({ ...A, key: "k1" }, run);
    expect(first).toEqual({ replayed: false, result: { id: 7 } });
    expect(second).toEqual({ replayed: true, result: { id: 7 } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("two simultaneous requests: one runs, the other gets 409 while it is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = vi.fn(async () => {
      await gate;
      return { id: "one" };
    });
    const winner = withIdempotency({ ...A, key: "k" }, run);
    await new Promise((r) => setTimeout(r, 0));
    await expect(withIdempotency({ ...A, key: "k" }, run)).rejects.toMatchObject({
      status: 409,
      code: "idempotency_in_progress",
    });
    release();
    expect(await winner).toEqual({ replayed: false, result: { id: "one" } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("deletes the reservation when run() throws, so a retry can run", async () => {
    await expect(withIdempotency({ ...A, key: "k" }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(store.rows).toHaveLength(0);
    const out = await withIdempotency({ ...A, key: "k" }, async () => ({ ok: true }));
    expect(out.replayed).toBe(false);
  });

  it("takes over a stale pending reservation but not a fresh one", async () => {
    store.rows.push({
      id: "p", workspace_id: "ws-1", actor_id: "usr_1", route: A.route, key: "k", status: "pending",
      result: null, request_hash: null, created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    const out = await withIdempotency({ ...A, key: "k" }, async () => ({ id: "took" }));
    expect(out).toEqual({ replayed: false, result: { id: "took" } });
    expect(store.rows[0]).toMatchObject({ id: "p", status: "done" });

    store.rows = [{
      id: "f", workspace_id: "ws-1", actor_id: "usr_1", route: A.route, key: "k2", status: "pending",
      result: null, request_hash: null, created_at: new Date().toISOString(),
    }];
    await expect(withIdempotency({ ...A, key: "k2" }, async () => 1)).rejects.toMatchObject({ status: 409 });
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
    store.rows.push({
      id: "old", workspace_id: "ws-1", actor_id: "usr_1", route: A.route, key: "k", status: "done",
      result: { id: "stale" }, created_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
    });
    const out = await withIdempotency({ ...A, key: "k" }, async () => ({ id: "fresh" }));
    expect(out).toEqual({ replayed: false, result: { id: "fresh" } });
    expect(store.rows.map((r) => r.id)).not.toContain("old");
  });

  it("answers 422 when a key is reused with a different body", async () => {
    await withIdempotency({ ...A, key: "k", bodyHash: hashRequestBody({ a: 1 }) }, async () => 1);
    await expect(
      withIdempotency({ ...A, key: "k", bodyHash: hashRequestBody({ a: 2 }) }, async () => 2),
    ).rejects.toMatchObject({ status: 422, message: "Idempotency-Key reused with a different request" });
    const same = await withIdempotency({ ...A, key: "k", bodyHash: hashRequestBody({ a: 1 }) }, async () => 3);
    expect(same).toEqual({ replayed: true, result: 1 });
  });

  it("still runs when the reservation cannot be stored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.failInsert = { message: "boom" };
    const out = await withIdempotency({ ...A, key: "k" }, async () => ({ id: 1 }));
    expect(out).toEqual({ replayed: false, result: { id: 1 } });
  });
});

describe("0074 migration text", () => {
  const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
  const sql = readFileSync(join(dir, "20261017000074_idempotency_pending.sql"), "utf8")
    .split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
  it("adds status (default done, pending|done check) and request_hash idempotently", () => {
    expect(sql).toMatch(/add column if not exists status text not null default 'done'/);
    expect(sql).toMatch(/add column if not exists request_hash text/);
    expect(sql).toMatch(/alter column result drop not null/);
    expect(sql).toMatch(/check \(status in \('pending', 'done'\)\)/);
  });
  it("purge function is service-role only with a pinned search_path", () => {
    expect(sql).toMatch(/create or replace function nopm_purge_idempotency_keys/);
    expect(sql).toMatch(/security definer\s+set search_path = public, pg_temp/);
    expect(sql).toMatch(/revoke all on function nopm_purge_idempotency_keys\(interval\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function nopm_purge_idempotency_keys\(interval\) to service_role/);
  });
});
