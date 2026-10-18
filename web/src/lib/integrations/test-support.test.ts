import { describe, it, expect } from "vitest";
import { FakeDb, CONNECTOR_ID, WS } from "./test-support";

/** The fake underpins every hub test, so pin the database semantics it claims. */
describe("FakeDb", () => {
  it("applies filters, ordering and limits like PostgREST", async () => {
    const db = new FakeDb().seed("t", [
      { id: "a", n: 3, s: "x", at: "2026-01-02" },
      { id: "b", n: 1, s: "y", at: null },
      { id: "c", n: 2, s: "x", at: "2026-01-01" },
    ]);
    const asc = await db.from("t").select("*").order("n", { ascending: true });
    expect((asc.data as { id: string }[]).map((r) => r.id)).toEqual(["b", "c", "a"]);
    const lim = await db.from("t").select("*").order("n", { ascending: false }).limit(2);
    expect((lim.data as { id: string }[]).map((r) => r.id)).toEqual(["a", "c"]);
    const nil = await db.from("t").select("*").is("at", null);
    expect((nil.data as unknown[]).length).toBe(1);
    // SQL semantics: a null column is neither equal nor unequal.
    const neq = await db.from("t").select("*").neq("at", "2026-01-01");
    expect((neq.data as { id: string }[]).map((r) => r.id)).toEqual(["a"]);
    const or = await db.from("t").select("*").or("at.is.null,at.lte.2026-01-01");
    expect((or.data as { id: string }[]).map((r) => r.id).sort()).toEqual(["b", "c"]);
    const notIn = await db.from("t").select("*").not("s", "in", '("y")');
    expect((notIn.data as { id: string }[]).map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  it("update ... returning only touches (and returns) matching rows, atomically", async () => {
    const db = new FakeDb().seed("t", [{ id: "a", used: null }, { id: "b", used: null }]);
    const first = await db.from("t").update({ used: "now" }).eq("id", "a").is("used", null).select("id");
    const second = await db.from("t").update({ used: "later" }).eq("id", "a").is("used", null).select("id");
    expect(first.data).toEqual([{ id: "a" }]);
    expect(second.data).toEqual([]); // the second claimant loses
    expect(db.rows("t").find((r) => r.id === "b")?.used).toBeNull();
  });

  it("enforces the migration's unique indexes, including the partial ones", async () => {
    const db = new FakeDb();
    const ident = (over = {}) => ({
      workspace_id: WS,
      connector_id: CONNECTOR_ID,
      external_tenant: "t",
      external_user_id: "u",
      profile_id: "p",
      ...over,
    });
    expect((await db.from("external_identities").insert(ident())).error).toBeNull();
    const dup = await db.from("external_identities").insert(ident());
    expect(dup.error?.code).toBe("23505");
    // A revoked row frees the slot (partial index: where revoked_at is null).
    await db.from("external_identities").update({ revoked_at: "now" }).eq("profile_id", "p");
    expect((await db.from("external_identities").insert(ident())).error).toBeNull();

    const claim = { workspace_id: WS, connector_id: CONNECTOR_ID, external_event_id: "e1", action: "approve" };
    expect((await db.from("inbound_actions").insert(claim)).error).toBeNull();
    expect((await db.from("inbound_actions").insert(claim)).error?.code).toBe("23505");
  });

  it("single() / maybeSingle() behave like PostgREST", async () => {
    const db = new FakeDb().seed("t", [{ id: "a" }, { id: "b" }]);
    expect((await db.from("t").select("*").eq("id", "zz").maybeSingle()).data).toBeNull();
    expect((await db.from("t").select("*").maybeSingle()).error?.code).toBe("PGRST116");
    const ins = await db.from("inbound_actions").insert({ workspace_id: WS, connector_id: CONNECTOR_ID, external_event_id: "x", action: "approve" }).select("id").single();
    expect(ins.error).toBeNull();
    expect(ins.data).toMatchObject({ id: expect.any(String) });
  });

  it("failNext injects a one-shot error", async () => {
    const db = new FakeDb().seed("t", [{ id: "a" }]);
    db.failNext({ table: "t", op: "select", error: { message: "boom" } });
    expect((await db.from("t").select("*")).error?.message).toBe("boom");
    expect((await db.from("t").select("*")).error).toBeNull();
  });

  it("reads jsonb text paths (payload->>trigger)", async () => {
    const db = new FakeDb().seed("t", [{ id: "a", payload: { trigger: "scheduled" } }, { id: "b", payload: { trigger: "manual" } }]);
    const res = await db.from("t").select("*").eq("payload->>trigger", "scheduled");
    expect((res.data as { id: string }[]).map((r) => r.id)).toEqual(["a"]);
  });
});
