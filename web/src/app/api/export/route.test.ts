/**
 * GET /api/export - route-level contract for the access-review entities (M5)
 * and the date range / provenance columns (M3). Auth is stubbed at
 * requireAuth only; the REAL requireScope and assertCanListMembers run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const { requireAuthMock, writeAuditMock, tables } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  writeAuditMock: vi.fn(async (..._a: unknown[]) => undefined),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));
vi.mock("@/lib/api/rate-limit", () => ({ checkRateLimit: async () => undefined }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: (...a: unknown[]) => (writeAuditMock as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/lib/integrations/time-zone", () => ({ workspaceToday: async () => "2026-10-18" }));

const queried: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const call = { table, ops: [] as Array<[string, unknown[]]> };
      queried.push(call);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "neq", "in", "overlaps", "like", "or", "gte", "lt", "order", "limit", "range"]) {
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

const call = (qs: string) =>
  GET(new NextRequest(`http://localhost/api/export${qs}`), { params: Promise.resolve({}) });

const session = (role: string): Actor => ({
  type: "user",
  id: "user-1",
  label: "person",
  workspaceId: "ws-1",
  role,
  principalId: "user-1",
});
const token = (scopes: string[]): Actor => ({
  type: "token",
  id: "tok-1",
  label: "agent",
  workspaceId: "ws-1",
  scopes,
  principalId: "user-1",
});

/** Strips the BOM and splits the CSV into header + lines. */
function lines(csv: string): string[] {
  return csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
}

beforeEach(() => {
  vi.clearAllMocks();
  queried.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("GET /api/export access-review entities", () => {
  for (const entity of ["members", "tokens", "identities"]) {
    it(`403s a member session on entity=${entity} and reads nothing`, async () => {
      requireAuthMock.mockResolvedValueOnce(session("member"));
      const res = await call(`?entity=${entity}`);
      expect(res.status).toBe(403);
      expect(queried).toHaveLength(0);
      expect(writeAuditMock).not.toHaveBeenCalled();
    });

    it(`403s a token holding every read scope on entity=${entity}`, async () => {
      requireAuthMock.mockResolvedValueOnce(token(["*"]));
      const res = await call(`?entity=${entity}`);
      expect(res.status).toBe(403);
      expect(writeAuditMock).not.toHaveBeenCalled();
    });
  }

  it("403s a viewer session on tokens", async () => {
    requireAuthMock.mockResolvedValueOnce(session("viewer"));
    expect((await call("?entity=tokens")).status).toBe(403);
  });

  it("exports tokens for a manager without the hash, scoped to the workspace, with one audit row", async () => {
    requireAuthMock.mockResolvedValueOnce(session("manager"));
    tables.api_tokens = [
      {
        id: "t1", name: "ci", prefix: "npm_", scopes: ["task:read", "risk:read"], created_by: "p1",
        expires_at: null, revoked: false, last_used_at: null, created_at: "2026-10-01T00:00:00Z",
        token_hash: "SHOULD-NEVER-APPEAR",
      },
    ];
    tables.profiles = [{ id: "p1", display_name: "Owner A", email: "a@example.test" }];
    const res = await call("?entity=tokens");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SHOULD-NEVER-APPEAR");
    expect(lines(text)[0]).toBe(
      "id,label,prefix,scopes,created_by,created_by_label,created_at,expires_at,revoked,last_used_at",
    );
    expect(lines(text)[1]).toContain("task:read risk:read");
    expect(lines(text)[1]).toContain("Owner A");
    const tokenQuery = queried.find((q) => q.table === "api_tokens")!;
    expect(tokenQuery.ops).toContainEqual(["eq", ["workspace_id", "ws-1"]]);
    expect(tokenQuery.ops).toContainEqual(["neq", ["kind", "assistant"]]);
    // never selects the hash
    const selected = tokenQuery.ops.find(([op]) => op === "select")![1][0] as string;
    expect(selected).not.toContain("token_hash");
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({
      action: "export.csv",
      after: expect.objectContaining({ entity: "tokens", row_count: 1 }),
    });
  });

  it("exports members with mfa_enabled and the last role change from audit", async () => {
    requireAuthMock.mockResolvedValueOnce(session("admin"));
    tables.profiles = [
      {
        id: "p1", email: "a@example.test", display_name: "Owner A", role: "admin", status: "active",
        created_at: "2026-09-01T00:00:00Z", removed_at: null,
      },
    ];
    tables.user_mfa = [{ user_id: "p1" }];
    tables.audit_log = [{ target_id: "p1", actor_label: "Admin B", created_at: "2026-10-05T00:00:00Z" }];
    const res = await call("?entity=members");
    expect(res.status).toBe(200);
    const [header, row] = lines(await res.text());
    expect(header).toBe(
      "id,display_name,email,role,status,mfa_enabled,created_at,removed_at,last_role_change_at,last_role_change_by",
    );
    expect(row).toBe(
      "p1,Owner A,a@example.test,admin,active,true,2026-09-01T00:00:00Z,,2026-10-05T00:00:00Z,Admin B",
    );
  });

  it("exports connector identities without the external user id", async () => {
    requireAuthMock.mockResolvedValueOnce(session("admin"));
    tables.external_identities = [
      {
        id: "i1", profile_id: "p1", provider: "lark", connector_id: "c1",
        linked_at: "2026-10-02T00:00:00Z", revoked_at: null, external_user_id: "ou_SECRET",
      },
    ];
    tables.profiles = [{ id: "p1", display_name: "Owner A", email: "a@example.test" }];
    const text = await (await call("?entity=identities")).text();
    expect(text).not.toContain("ou_SECRET");
    expect(lines(text)[1]).toBe("i1,p1,Owner A,lark,c1,2026-10-02T00:00:00Z,");
  });
});

describe("GET /api/export date range and audit provenance", () => {
  it("includes principal_id and a resolved principal_label in the audit CSV", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["audit:read"]));
    tables.audit_log = [
      {
        id: "a1", workspace_id: "ws-1", actor_type: "token", actor_id: "tok-1", actor_label: "agent",
        action: "task.update", target_type: "task", target_id: "t1", before: null, after: null,
        channel: "mcp", request_id: "req-1", created_at: "2026-10-10T00:00:00Z",
        principal_id: "p1", via_connector_id: "c9", external_event_id: "ev-1", external_actor_ref: "lark:t:ou_1",
      },
      {
        id: "a2", workspace_id: "ws-1", actor_type: "user", actor_id: "p2", actor_label: "x",
        action: "task.update", target_type: "task", target_id: "t2", before: null, after: null,
        channel: "ui", request_id: null, created_at: "2026-10-11T00:00:00Z", principal_id: null,
      },
    ];
    tables.profiles = [{ id: "p1", display_name: "Owner A", email: "a@example.test" }];
    const text = await (await call("?entity=audit")).text();
    const [header, r1, r2] = lines(text);
    expect(header.split(",")).toEqual(
      expect.arrayContaining([
        "principal_id", "principal_label", "via_connector_id", "external_event_id", "external_actor_ref",
      ]),
    );
    expect(r1).toContain("p1,Owner A,c9,ev-1,lark:t:ou_1");
    expect(r2.endsWith(",,,,,")).toBe(true);
    // one profiles query for all principals, not one per row
    expect(queried.filter((q) => q.table === "profiles")).toHaveLength(1);
  });

  it("puts row_hash LAST in the audit CSV so a chain can be recomputed offline (R-154)", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["audit:read"]));
    tables.audit_log = [
      {
        id: "a1", workspace_id: "ws-1", actor_type: "user", actor_id: "p2", actor_label: "x",
        action: "task.update", target_type: "task", target_id: "t2", before: null, after: null,
        channel: "ui", request_id: null, created_at: "2026-10-11T00:00:00Z", principal_id: null,
        row_hash: "deadbeef",
      },
    ];
    tables.profiles = [];
    const [header, r1] = lines(await (await call("?entity=audit")).text());
    const cols = header.split(",");
    expect(cols[cols.length - 1]).toBe("row_hash");
    expect(r1.split(",").pop()).toBe("deadbeef");
  });

  it("applies from/to to a non-audit entity and records the range in the audit row", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["risk:read"]));
    tables.risks = [];
    const res = await call("?entity=risks&from=2026-10-01&to=2026-10-17");
    expect(res.status).toBe(200);
    const q = queried.find((x) => x.table === "risks")!;
    expect(q.ops).toContainEqual(["gte", ["created_at", "2026-10-01T00:00:00Z"]]);
    expect(q.ops).toContainEqual(["lt", ["created_at", "2026-10-18T00:00:00.000Z"]]);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({
      after: { entity: "risks", filters: expect.objectContaining({ from: "2026-10-01", to: "2026-10-17", on: "created" }) },
    });
  });

  it("filters on updated_at when on=updated and the entity has one", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["task:read"]));
    await call("?entity=tasks&from=2026-10-01&on=updated");
    const q = queried.find((x) => x.table === "tasks")!;
    expect(q.ops).toContainEqual(["gte", ["updated_at", "2026-10-01T00:00:00Z"]]);
  });

  it("keeps created_at for audit even with on=updated (no updated_at column)", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["audit:read"]));
    await call("?entity=audit&from=2026-10-01&on=updated");
    const q = queried.find((x) => x.table === "audit_log")!;
    expect(q.ops).toContainEqual(["gte", ["created_at", "2026-10-01T00:00:00Z"]]);
  });

  it("still 403s a token without the entity's read scope", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["task:read"]));
    expect((await call("?entity=audit")).status).toBe(403);
  });
});

describe("GET /api/export risks and chunking", () => {
  it("selects the explicit risk list, exports risk_category and impact_areas, applies any-of impact_area", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["risk:read"]));
    tables.risks = [{ id: "r1", title: "t", risk_category: "technical", impact_areas: ["cost", "scope"], category: "legacy" }];
    const res = await call("?entity=risks&impact_area=cost,bogus");
    const text = await res.text();
    const [header, row] = lines(text);
    expect(header).toContain("risk_category,impact_areas");
    expect(header.split(",")).not.toContain("category");
    expect(row).toContain("technical,cost scope");
    const q = queried.find((x) => x.table === "risks")!;
    const selected = q.ops.find(([op]) => op === "select")![1][0] as string;
    expect(selected).not.toBe("*");
    expect(q.ops).toContainEqual(["overlaps", [ "impact_areas", ["cost"] ]]);
  });

  it("chunks the members lookups by 100 ids", async () => {
    requireAuthMock.mockResolvedValueOnce(session("admin"));
    tables.profiles = Array.from({ length: 250 }, (_, i) => ({ id: "p" + i, role: "member", status: "active", created_at: "2026-09-01T00:00:00Z" }));
    await call("?entity=members");
    const audits = queried.filter((q) => q.table === "audit_log");
    expect(audits).toHaveLength(3);
    for (const a of audits) {
      const ids = a.ops.find(([op]) => op === "in")![1][1] as string[];
      expect(ids.length).toBeLessThanOrEqual(100);
    }
  });
});
