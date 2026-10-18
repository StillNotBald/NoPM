/**
 * GET /api/review — route-level contract: auth is enforced by route(), scope
 * rules come from the REAL requireScope (only requireAuth is stubbed), and the
 * response keeps the { data, total, page, limit } list contract plus
 * hidden_kinds. The query layer itself is covered in lib/review/pending.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { AuthError } from "@/lib/api/errors";
import type { Actor } from "@/lib/auth/guard";

const { requireAuthMock, tables } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));
vi.mock("@/lib/api/rate-limit", () => ({ checkRateLimit: async () => undefined }));

const queried: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const call = { table, ops: [] as Array<[string, unknown[]]> };
      queried.push(call);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "order", "limit"]) {
        chain[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return chain;
        };
      }
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        const data = tables[table] ?? [];
        return Promise.resolve({ data, count: data.length, error: null }).then(res, rej);
      };
      return chain;
    },
  }),
}));

import { GET } from "./route";

const call = (qs = "") =>
  GET(new NextRequest(`http://localhost/api/review${qs}`), { params: Promise.resolve({}) });

const tokenActor = (scopes: string[], principalId: string | null = "owner-1"): Actor => ({
  type: "token",
  id: "tok-1",
  label: "agent",
  workspaceId: "ws-1",
  scopes,
  principalId,
});
const sessionActor = (role: string): Actor => ({
  type: "user",
  id: "user-1",
  label: "person",
  workspaceId: "ws-1",
  role,
  principalId: "user-1",
});

const changeRow = {
  id: "cr-1",
  project_id: null,
  reference_id: null,
  title: "Extend scope",
  status: "raised",
  category: "scope",
  priority: "medium",
  requested_by: "user-9",
  requested_by_type: "user",
  requested_by_id: "user-9",
  requested_by_label: "Requester A",
  raised_at: "2026-10-09T08:00:00+00:00",
};

beforeEach(() => {
  vi.clearAllMocks();
  queried.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("GET /api/review", () => {
  it("401s an unauthenticated caller with the { error, code } contract", async () => {
    requireAuthMock.mockRejectedValueOnce(new AuthError());
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required", code: "unauthorized" });
    expect(queried).toHaveLength(0);
  });

  it("returns the list contract plus hidden_kinds for a token that reads change requests only", async () => {
    requireAuthMock.mockResolvedValueOnce(tokenActor(["change:read", "change:decide"]));
    tables.change_requests = [changeRow];
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      total: 1,
      page: 1,
      limit: 50,
      hidden_kinds: ["task_deletion", "project_deletion", "rebaseline"],
    });
    expect(body.data).toEqual([
      {
        kind: "change_request",
        id: "cr-1",
        title: "Change request: Extend scope",
        summary: "raised · scope · medium priority",
        project_id: null,
        project_name: null,
        requested_by_label: "Requester A",
        requested_at: "2026-10-09T08:00:00+00:00",
        can_decide: true,
        reason_if_not: null,
        assigned_approver_id: null,
        assigned_to_me: false,
      },
    ]);
    // every query carries the caller's workspace
    for (const q of queried) expect(q.ops).toContainEqual(["eq", ["workspace_id", "ws-1"]]);
  });

  it("403s a token with no read scope for any approval family", async () => {
    requireAuthMock.mockResolvedValueOnce(tokenActor(["risk:read"]));
    const res = await call();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("forbidden_scope");
    expect(body.error).toMatch(/needs one of/);
  });

  it("lets a read-only token see items but flags them as not decidable (scope reason)", async () => {
    requireAuthMock.mockResolvedValueOnce(tokenActor(["change:read"]));
    tables.change_requests = [changeRow];
    const body = await (await call()).json();
    expect(body.data[0]).toMatchObject({
      can_decide: false,
      reason_if_not: "API token is missing required scope: change:decide",
    });
  });

  it("wildcards do not make a token a decider (privileged scopes need exact names)", async () => {
    requireAuthMock.mockResolvedValueOnce(tokenActor(["change:*"]));
    tables.change_requests = [changeRow];
    const body = await (await call()).json();
    // change:* reads, but is not change:decide
    expect(body.data[0].can_decide).toBe(false);
  });

  it("shows a viewer every kind but never lets them decide", async () => {
    requireAuthMock.mockResolvedValueOnce(sessionActor("viewer"));
    tables.change_requests = [changeRow];
    const body = await (await call()).json();
    expect(body.hidden_kinds).toEqual([]);
    expect(body.data[0]).toMatchObject({ can_decide: false, reason_if_not: "Viewers have read-only access" });
  });

  it("lets a manager decide another person's request", async () => {
    requireAuthMock.mockResolvedValueOnce(sessionActor("manager"));
    tables.change_requests = [changeRow];
    const body = await (await call()).json();
    expect(body.data[0]).toMatchObject({ can_decide: true, reason_if_not: null });
  });

  it("422s an unknown ?kind", async () => {
    requireAuthMock.mockResolvedValueOnce(sessionActor("manager"));
    const res = await call("?kind=change_request,banana");
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields[0].field).toBe("kind");
    expect(body.fields[0].message).toMatch(/banana/);
  });

  it("accepts comma-separated and repeated ?kind and narrows the queries", async () => {
    requireAuthMock.mockResolvedValueOnce(sessionActor("manager"));
    await call("?kind=change_request&kind=rebaseline");
    expect(queried.map((q) => q.table).sort()).toEqual(["change_requests", "rebaselines"]);
  });

  it("clamps limit to 200 and ignores junk paging input", async () => {
    requireAuthMock.mockResolvedValueOnce(sessionActor("manager"));
    const a = await (await call("?limit=5000&page=abc")).json();
    expect(a).toMatchObject({ limit: 200, page: 1 });
    requireAuthMock.mockResolvedValueOnce(sessionActor("manager"));
    const b = await (await call("?limit=nope")).json();
    expect(b.limit).toBe(50);
  });
});
