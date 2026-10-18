import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  head: { data: { row_hash: "abc123" } as { row_hash: string } | null, error: null as unknown },
  writeAudit: vi.fn(),
  requireAuth: vi.fn(),
  selects: [] as unknown[],
  gate: { allowed: true, retry_after_seconds: 0 },
  last: { data: null as unknown, error: null as unknown },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (name: string, args: { p_key?: string }) =>
      name === "nopm_rate_check"
        ? { data: String(args.p_key).startsWith("audit-verify:") ? h.gate : { allowed: true, remaining: 99, retry_after_seconds: 0 }, error: null }
        : h.verify(name, args),
    from: (table: string) => {
      let wantsLast = false;
      const q = {
        select: (cols?: string) => ((wantsLast = String(cols).includes("after")), q),
        eq: (c: string, v: unknown) => (h.selects.push([table, c, v]), q),
        order: () => q,
        limit: () => q,
        maybeSingle: async () => (wantsLast ? h.last : h.head),
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
  h.head.data = { row_hash: "abc123" };
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
