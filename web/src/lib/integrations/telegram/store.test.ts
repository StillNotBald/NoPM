import { describe, it, expect, vi, beforeEach } from "vitest";
import { fixtureConnector } from "./fixtures";

type Call = { op: string; table: string; args: unknown[]; filters: [string, string, unknown][] };
const calls: Call[] = [];
let insertError: { code: string } | null = null;
let reclaimRows: unknown[] = [];

function builder(table: string) {
  let op = "";
  let args: unknown[] = [];
  const filters: [string, string, unknown][] = [];
  const q: Record<string, unknown> = {};
  const record = () => calls.push({ op, table, args, filters });
  for (const m of ["eq", "lt"]) q[m] = (col: string, val: unknown) => (filters.push([m, col, val]), q);
  q.select = () => q;
  q.then = (resolve: (v: unknown) => void) => {
    record();
    if (op === "insert") return resolve({ error: insertError });
    if (op === "update" && filters.some(([, c, v]) => c === "status" && v === "failed")) return resolve({ data: reclaimRows, error: null });
    return resolve({ data: null, error: null });
  };
  return {
    insert: (row: unknown) => ((op = "insert"), (args = [row]), q),
    update: (patch: unknown) => ((op = "update"), (args = [patch]), q),
    delete: () => ((op = "delete"), q),
  };
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => builder(t) }) }));

import { createPendingStore } from "./store";

beforeEach(() => {
  calls.length = 0;
  insertError = null;
  reclaimRows = [];
});

describe("chat_pending store: dedupe, retry and purge (review round 1)", () => {
  it("a new key is claimed, and rows older than 7 days are purged on that insert", async () => {
    const store = createPendingStore();
    expect(await store.dedupe(fixtureConnector(), "1", "u:5")).toBe(true);
    const ins = calls.find((c) => c.op === "insert")!;
    expect((ins.args[0] as { status: string }).status).toBe("claimed");
    const del = calls.find((c) => c.op === "delete")!;
    expect(del.filters.find(([m, c]) => m === "lt" && c === "created_at")).toBeTruthy();
    const cutoff = Date.parse(String(del.filters.find(([, c]) => c === "created_at")![2]));
    const ageDays = (Date.now() - cutoff) / 86_400_000;
    expect(ageDays).toBeGreaterThan(6.9);
    expect(ageDays).toBeLessThan(7.1);
    expect(del.filters).toContainEqual(["eq", "workspace_id", fixtureConnector().workspace_id]);
  });

  it("a key being processed or finished is a duplicate", async () => {
    insertError = { code: "23505" };
    expect(await createPendingStore().dedupe(fixtureConnector(), "1", "u:5")).toBe(false);
  });

  it("a key whose processing FAILED is claimed again, by compare-and-swap on status = failed", async () => {
    insertError = { code: "23505" };
    reclaimRows = [{ id: "x" }];
    expect(await createPendingStore().dedupe(fixtureConnector(), "1", "u:5")).toBe(true);
    const upd = calls.find((c) => c.op === "update")!;
    expect(upd.filters).toContainEqual(["eq", "status", "failed"]);
    expect(upd.args[0]).toEqual({ status: "claimed" });
  });

  it("any other insert error fails closed", async () => {
    insertError = { code: "XX000" };
    await expect(createPendingStore().dedupe(fixtureConnector(), "1", "u:5")).rejects.toBeTruthy();
  });

  it("finishSeen records the outcome on the connector's key", async () => {
    await createPendingStore().finishSeen(fixtureConnector(), "u:5", "failed");
    const upd = calls.find((c) => c.op === "update")!;
    expect(upd.args[0]).toEqual({ status: "failed" });
    expect(upd.filters).toContainEqual(["eq", "dedupe_key", "u:5"]);
  });
});
