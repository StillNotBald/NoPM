import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  head: { data: { row_hash: "abc123", chain_seq: 10 } as { row_hash: string; chain_seq?: number } | null, error: null as unknown },
  writeAudit: vi.fn(),
  requireAuth: vi.fn(),
  selects: [] as unknown[],
  gate: { allowed: true, retry_after_seconds: 0 },
  last: { data: null as unknown, error: null as unknown },
  // external anchor (R-168/R-169)
  sink: undefined as unknown,
  receipt: { data: null as unknown, error: null as unknown },
  receiptSaves: [] as unknown[],
  hashAt: {} as Record<number, string>,
  order: [] as string[],
}));
vi.mock("@/lib/audit/anchor/get-sink", () => ({
  getAnchorSink: () => h.sink ?? { kind: "none", put: async () => ({ status: "disabled" }), latest: async () => ({ ok: true, records: new Map() }) },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (name: string, args: { p_key?: string }) =>
      name === "nopm_rate_check"
        ? { data: String(args.p_key).startsWith("audit-verify:") ? h.gate : { allowed: true, remaining: 99, retry_after_seconds: 0 }, error: null }
        : h.verify(name, args),
    from: (table: string) => {
      let wantsLast = false;
      let atSeq: number | null = null;
      const q = {
        select: (cols?: string) => ((wantsLast = String(cols).includes("after")), q),
        eq: (c: string, v: unknown) => (c === "chain_seq" && (atSeq = Number(v)), h.selects.push([table, c, v]), q),
        not: () => q,
        order: () => q,
        limit: () => q,
        upsert: async (row: unknown) => (h.receiptSaves.push(row), { error: null }),
        maybeSingle: async () => {
          if (table === "audit_anchor_receipts") return h.receipt;
          if (atSeq !== null) return { data: h.hashAt[atSeq] ? { row_hash: h.hashAt[atSeq] } : null, error: null };
          return wantsLast ? h.last : h.head;
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/audit/write", () => ({ writeAudit: h.writeAudit }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: h.requireAuth,
}));

import { GET } from "./route";

const WS = "11111111-1111-4111-8111-111111111111";
const NO_PARAMS = { params: Promise.resolve({}) };
const call = (qs = "") => GET(new NextRequest(`http://localhost:3000/api/audit/verify${qs}`), NO_PARAMS);
const as = (over: Partial<Actor>) =>
  h.requireAuth.mockResolvedValue({ type: "user", id: "u1", label: "Ada", workspaceId: WS, role: "admin", ...over } as Actor);

beforeEach(() => {
  h.verify.mockReset();
  h.writeAudit.mockReset();
  h.requireAuth.mockReset();
  h.selects.length = 0;
  h.head.data = { row_hash: "abc123", chain_seq: 10 };
  h.sink = undefined;
  h.receipt = { data: null, error: null };
  h.receiptSaves.length = 0;
  h.hashAt = { 10: "abc123" };
  h.order.length = 0;
  h.gate = { allowed: true, retry_after_seconds: 0 };
  h.last = { data: null, error: null };
  h.verify.mockResolvedValue({ data: [{ ok: true, checked: "42", first_bad_id: null, first_bad_at: null }], error: null });
  as({});
});

describe("GET /api/audit/verify (R-154)", () => {
  it("answers 403 to a token, whatever its scopes", async () => {
    as({ type: "token", role: undefined, scopes: ["audit:read", "*"] } as Partial<Actor>);
    expect((await call()).status).toBe(403);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it.each(["member", "viewer"])("answers 403 to a %s session", async (role) => {
    as({ role: role as Actor["role"] });
    expect((await call()).status).toBe(403);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it.each(["admin", "manager"])("lets a %s session verify and returns the result shape", async (role) => {
    as({ role: role as Actor["role"] });
    const res = await call();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ ok: true, checked: 42, first_bad_id: null, first_bad_at: null, from: null, head_hash: "abc123" });
    expect(typeof data.verified_at).toBe("string");
    expect(h.verify).toHaveBeenCalledWith("nopm_audit_verify_chain", { p_workspace_id: WS, p_from: null, p_limit: 50000 });
  });

  it("scopes the check to the caller's workspace and passes ?from through", async () => {
    await call("?from=2026-10-01T00:00:00Z");
    expect(h.verify).toHaveBeenCalledWith("nopm_audit_verify_chain", { p_workspace_id: WS, p_from: "2026-10-01T00:00:00Z", p_limit: 50000 });
    expect(h.selects).toContainEqual(["audit_log", "workspace_id", WS]);
  });

  it("passes ?limit to the database and rejects a bad one with 422", async () => {
    await call("?limit=1000");
    expect(h.verify).toHaveBeenCalledWith("nopm_audit_verify_chain", { p_workspace_id: WS, p_from: null, p_limit: 1000 });
    h.verify.mockClear();
    for (const bad of ["0", "-5", "abc", "1.5", "200001"]) expect((await call(`?limit=${bad}`)).status).toBe(422);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("throttles to one run per workspace per 5 minutes: 429, Retry-After, the last result, no database walk, no audit row", async () => {
    h.gate = { allowed: false, retry_after_seconds: 120 };
    h.last = { data: { after: { ok: true, checked: 42, head_hash: "abc123" }, created_at: "2026-10-18T01:00:00Z" }, error: null };
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
    const body = await res.json();
    expect(body).toMatchObject({ code: "verify_throttled", retry_after_seconds: 120, last_result: { ok: true, checked: 42, recorded_at: "2026-10-18T01:00:00Z" } });
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it("the throttle is per workspace and still lets a first call through", async () => {
    await call();
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("returns where the checked window began (first_seq)", async () => {
    h.verify.mockResolvedValue({ data: [{ ok: true, checked: 10, first_bad_id: null, first_bad_at: null, first_seq: 91 }], error: null });
    const { data } = await (await call("?limit=10")).json();
    expect(data).toMatchObject({ first_seq: 91, limit: 10 });
  });

  it("rejects an unparsable ?from with 422 before touching the database", async () => {
    expect((await call("?from=yesterday")).status).toBe(422);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("writes exactly one audit.verified row carrying the result", async () => {
    await call();
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      action: "audit.verified",
      targetType: "audit_log",
      after: { ok: true, checked: 42, head_hash: "abc123" },
    });
  });

  it("reports a broken chain with the first bad row, and still audits it", async () => {
    h.verify.mockResolvedValue({
      data: [{ ok: false, checked: 7, first_bad_id: "r-8", first_bad_at: "2026-10-02T00:00:00Z" }],
      error: null,
    });
    const { data } = await (await call()).json();
    expect(data).toMatchObject({ ok: false, checked: 7, first_bad_id: "r-8", first_bad_at: "2026-10-02T00:00:00Z" });
    expect(h.writeAudit.mock.calls[0][0].after).toMatchObject({ ok: false, first_bad_id: "r-8" });
  });

  it("fails closed (500) and writes no audit row when the database errors", async () => {
    h.verify.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await call()).status).toBe(500);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});

// ── External anchor (R-168 / R-169 / R-170) ─────────────────────────────────────────────────────────
type Rec = { workspace_id: string; chain_seq: number; head_hash: string; row_count: number; anchored_at: string };
const stored = (over: Partial<Rec> = {}): Rec => ({ workspace_id: WS, chain_seq: 10, head_hash: "abc123", row_count: 10, anchored_at: "2026-10-18T20:09:00.000Z", ...over });

function useSink(latest: Rec | null | "down", put: (r: Rec) => Promise<unknown> = async (r) => ({ status: "stored", record: r })) {
  const sink = {
    kind: "fake",
    latest: vi.fn(async () => (latest === "down" ? { ok: false, error: "connect ECONNREFUSED [host]" } : { ok: true, records: new Map(latest ? [[WS, latest]] : []) })),
    put: vi.fn(async (r: Rec) => (h.order.push("put"), put(r))),
  };
  h.sink = sink;
  return sink;
}
/** Writing an audit row appends it to the live chain: the head moves to seq+1. */
function chainGrowsOnAudit() {
  h.writeAudit.mockImplementation(async (i: { action: string }) => {
    h.order.push(`audit:${i.action}`);
    const seq = (h.head.data?.chain_seq ?? 0) + 1;
    h.head.data = { row_hash: `abc${seq}`, chain_seq: seq };
    h.hashAt[seq] = `abc${seq}`;
  });
}
const audited = () => h.writeAudit.mock.calls.map((c) => c[0].action);

describe("GET /api/audit/verify: external anchor", () => {
  it("with NOPM_ANCHOR_DB_URL unset (sink none) says not_anchored, writes nothing, and is an all-clear", async () => {
    const { data } = await (await call()).json();
    expect(data.anchor).toEqual({ state: "not_anchored", chain_seq: null, anchored_at: null, row_count: null, rows_behind: null, since: null });
    expect(data).toMatchObject({ ok: true, chain_ok: true, all_clear: true });
    expect(h.writeAudit.mock.calls[0][0].after.anchor).toMatchObject({ state: "not_anchored", chain_seq: null });
    expect(h.receiptSaves).toHaveLength(0);
  });

  it("state anchored: verifies, writes audit.verified, THEN anchors the head that includes the verify row (PR-13)", async () => {
    chainGrowsOnAudit();
    const sink = useSink(stored({ chain_seq: 8, head_hash: "old" }));
    h.hashAt[8] = "old";
    const { data } = await (await call()).json();
    expect(h.order).toEqual(["audit:audit.verified", "put"]);
    expect(sink.put).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: WS, chain_seq: 11, head_hash: "abc11", row_count: 11 }));
    expect(data.anchor).toMatchObject({ state: "anchored", chain_seq: 11 });
    expect(data).toMatchObject({ ok: true, all_clear: true });
    expect(h.writeAudit.mock.calls[0][0].after.anchor).toMatchObject({ state: "behind", chain_seq: 8, rows_behind: 2 });
    expect(audited()).toEqual(["audit.verified"]); // a routine success writes no extra audit row
  });

  it("the first anchor of a workspace is announced by ONE audit.anchored row after the sink confirmed", async () => {
    chainGrowsOnAudit();
    useSink(null);
    const { data } = await (await call()).json();
    expect(data.anchor.state).toBe("anchored");
    expect(h.order).toEqual(["audit:audit.verified", "put", "audit:audit.anchored"]);
  });

  it("state mismatch (newest rows deleted): ok false, chain_ok true, never anchors, ONE audit.anchor_mismatch per streak", async () => {
    chainGrowsOnAudit();
    const sink = useSink(stored({ chain_seq: 14, head_hash: "gone" }));
    const first = (await (await call()).json()).data;
    expect(first).toMatchObject({ ok: false, chain_ok: true, all_clear: false });
    expect(first.anchor).toMatchObject({ state: "mismatch", chain_seq: 14 });
    expect(sink.put).not.toHaveBeenCalled();
    expect(audited()).toEqual(["audit.anchor_mismatch", "audit.verified"]);
    // a second verify in the same streak: the receipt already says mismatch, so no second mismatch row
    h.receipt = { data: { workspace_id: WS, status: "mismatch", chain_seq: 14, streak_started_at: "2026-10-19T00:00:00Z" }, error: null };
    h.writeAudit.mockClear();
    chainGrowsOnAudit();
    await call();
    expect(audited()).toEqual(["audit.verified"]);
  });

  it("state mismatch for a flipped hash at the anchored chain_seq", async () => {
    useSink(stored({ chain_seq: 10, head_hash: "abc123" }));
    h.head.data = { row_hash: "flipped", chain_seq: 10 };
    const { data } = await (await call()).json();
    expect(data).toMatchObject({ ok: false, all_clear: false });
    expect(data.anchor.state).toBe("mismatch");
  });

  it("state mismatch when the chain was deleted and regrew to the same chain_seq with a different hash", async () => {
    useSink(stored({ chain_seq: 7, head_hash: "was7" }));
    h.hashAt[7] = "regrown7";
    const { data } = await (await call()).json();
    expect(data).toMatchObject({ ok: false, all_clear: false });
    expect(data.anchor.state).toBe("mismatch");
  });

  it("state unreachable: no comparison ran, so never anchored and never an all-clear; ONE audit.anchor_failed; request still 200", async () => {
    const sink = useSink("down");
    const res = await call();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.anchor.state).toBe("unreachable");
    expect(data).toMatchObject({ ok: true, chain_ok: true, all_clear: false });
    expect(sink.put).not.toHaveBeenCalled();
    expect(audited()).toEqual(["audit.anchor_failed", "audit.verified"]);
  });

  it("a failed put never fails the request: anchor.state unreachable, one audit.anchor_failed, all_clear false", async () => {
    chainGrowsOnAudit();
    useSink(stored({ chain_seq: 8, head_hash: "old" }), async () => ({ status: "failed", error: "timeout" }));
    h.hashAt[8] = "old";
    const res = await call();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.anchor.state).toBe("unreachable");
    expect(data).toMatchObject({ ok: true, all_clear: false });
    expect(audited()).toEqual(["audit.verified", "audit.anchor_failed"]);
    expect(h.receiptSaves.some((r) => (r as { status?: string }).status === "failed")).toBe(true);
  });

  it("a unique conflict on the head is a mismatch, not a failed insert", async () => {
    chainGrowsOnAudit();
    useSink(stored({ chain_seq: 8, head_hash: "old" }), async (r) => ({ status: "conflict", stored: { ...r, head_hash: "someone-else" } }));
    h.hashAt[8] = "old";
    const { data } = await (await call()).json();
    expect(data.anchor.state).toBe("mismatch");
    expect(data).toMatchObject({ ok: false, all_clear: false });
    expect(audited()).toEqual(["audit.verified", "audit.anchor_mismatch"]);
  });

  it("a chain that does not verify is never anchored", async () => {
    h.verify.mockResolvedValue({ data: [{ ok: false, checked: 7, first_bad_id: "r-8", first_bad_at: "2026-10-02T00:00:00Z" }], error: null });
    const sink = useSink(stored());
    const { data } = await (await call()).json();
    expect(data).toMatchObject({ ok: false, chain_ok: false });
    expect(sink.put).not.toHaveBeenCalled();
  });

  it("keeps the throttle: a second call inside the window never touches the sink", async () => {
    h.gate = { allowed: false, retry_after_seconds: 60 };
    const sink = useSink(stored());
    expect((await call()).status).toBe(429);
    expect(sink.latest).not.toHaveBeenCalled();
    expect(sink.put).not.toHaveBeenCalled();
  });

  it("an unexpected error while anchoring does not fail a verify that succeeded", async () => {
    chainGrowsOnAudit();
    useSink(stored({ chain_seq: 8, head_hash: "old" }), async () => {
      throw new Error("unexpected");
    });
    h.hashAt[8] = "old";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    expect(res.status).toBe(200);
  });
});
