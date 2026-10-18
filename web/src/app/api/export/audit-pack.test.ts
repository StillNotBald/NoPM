/**
 * GET /api/export - change_requests entity and the audit pack (audit item M3).
 * Auth is stubbed at requireAuth only; the REAL requireScope and the pack gate run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const { requireAuthMock, writeAuditMock, tables, errors } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  writeAuditMock: vi.fn(async (..._args: unknown[]) => undefined),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  // table -> error message returned for any select that names the given column
  errors: {} as Record<string, { column: string; message: string; code?: string }>,
}));

vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));
vi.mock("@/lib/api/rate-limit", () => ({ checkRateLimit: async () => undefined }));
vi.mock("@/lib/audit/write", () => ({
  writeAudit: (...a: unknown[]) => (writeAuditMock as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/integrations/time-zone", () => ({ workspaceToday: async () => "2026-10-18" }));

const queried: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const call = { table, ops: [] as Array<[string, unknown[]]> };
      queried.push(call);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "neq", "in", "like", "or", "gte", "lt", "order", "limit", "range"]) {
        chain[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return chain;
        };
      }
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        const sel = call.ops.find(([op]) => op === "select");
        const failing = errors[table];
        if (failing && String(sel?.[1][0] ?? "").includes(failing.column) ) {
          return Promise.resolve({ data: null, count: null, error: { message: failing.message, code: failing.code } }).then(res, rej);
        }
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
  label: "Auditor Liaison",
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

const lines = (csv: string): string[] => csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);

function seed() {
  tables.workspaces = [{ name: "Acme Delivery" }];
  tables.change_requests = [
    {
      id: "cr1", project_id: "p1", reference_id: "CR-001", title: "Move go-live", category: "schedule",
      status: "implemented", priority: "high", raised_at: "2026-10-02T00:00:00Z", requested_by_label: "Rae",
      requested_principal_id: "u-rae", decided_at: "2026-10-03T09:00:00Z", decided_by_label: "Sam",
      decided_principal_id: "u-sam", decision_rationale: "Vendor slip", impact_schedule_days: 5, impact_cost: 1200,
      impact_scope: [{ area: "schedule", direction: "increase", note: "5 days" }, { area: "cost", direction: "increase", note: null }], implemented_at: "2026-10-05T00:00:00Z",
      implemented_principal_id: "u-lee", implemented_by: "u-lee",
    },
    {
      id: "cr2", project_id: "p1", reference_id: "CR-002", title: "Drop reporting module", category: "scope",
      status: "rejected", priority: "low", raised_at: "2026-10-04T00:00:00Z", requested_by_label: "Rae",
      decided_at: "2026-10-06T00:00:00Z", decided_by_label: "Sam", decision_rationale: "Out of scope",
    },
  ];
  tables.projects = [{ id: "p1", code: "ALPHA" }];
  tables.profiles = [{ id: "u-lee", display_name: "Lee Implementer", email: "lee@example.test" }];
  tables.documents = [
    {
      id: "d1", reference_id: "DOC-1", title: "UAT sign-off", doc_type: "evidence", status: "approved",
      created_at: "2026-10-05T00:00:00Z", change_request_id: "cr1", evidence_type: "uat", evidence_result: "pass",
      tested_by_label: "Pat", tested_at: "2026-10-05T08:00:00Z", evidence_note: "all green",
    },
    {
      id: "d2", reference_id: "DOC-2", title: "Smoke run", doc_type: "evidence", status: "approved",
      created_at: "2026-10-06T00:00:00Z", change_request_id: "cr1", evidence_type: "test", evidence_result: "fail",
      tested_by_label: "Pat", tested_at: "2026-10-06T08:00:00Z", evidence_note: "",
    },
  ];
  tables.decisions = [
    {
      id: "dec1", reference_id: "DEC-1", title: "Adopt vendor B", decision: "Go", rationale: "Cheaper",
      status: "accepted", decided_by_label: "Sam", decided_at: "2026-10-03T00:00:00Z",
      created_at: "2026-10-03T00:00:00Z", change_request_id: "cr1",
    },
  ];
  tables.audit_log = [
    {
      id: "a1", action: "change_request.decide", actor_type: "user", actor_label: "Sam", principal_id: "u-lee",
      target_type: "change_request", target_id: "cr1", created_at: "2026-10-03T09:00:00Z",
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  queried.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of Object.keys(errors)) delete errors[k];
});

describe("GET /api/export?entity=change_requests", () => {
  it("403s a token without change:read and reads nothing", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["task:read"]));
    expect((await call("?entity=change_requests")).status).toBe(403);
    expect(queried).toHaveLength(0);
  });

  it("exports the evidence-chain columns, workspace-filtered, with roll-ups and one export.csv audit row", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["change:read"]));
    seed();
    const res = await call("?entity=change_requests&from=2026-10-01&to=2026-10-31");
    expect(res.status).toBe(200);
    const [header, first, second] = lines(await res.text());
    expect(header).toBe(
      "id,ref,project_id,project_code,title,category,status,priority,raised_at,requested_by_label,requested_principal_id,decided_at,decided_by_label,decided_principal_id,decision,decision_note,impact_schedule_days,impact_cost,impact_scope,implemented_at,implemented_by_label,evidence_count,evidence_pass,evidence_fail,evidence_latest_at,linked_decisions",
    );
    expect(first).toContain("CR-001");
    expect(first).toContain("ALPHA");
    expect(first).toContain(",approve,Vendor slip,5,1200,schedule:increase (5 days); cost:increase,2026-10-05T00:00:00Z,Lee Implementer,2,1,1,2026-10-06T08:00:00Z,DEC-1");
    // second row: nothing implemented, no evidence, decision = reject
    expect(second).toContain(",reject,Out of scope,");
    expect(second).toContain(",0,0,0,,");
    const crQuery = queried.find((q) => q.table === "change_requests")!;
    expect(crQuery.ops).toContainEqual(["eq", ["workspace_id", "ws-1"]]);
    // same selection rule as the pack: raised, decided or implemented in range
    const orFilter = crQuery.ops.find(([op]) => op === "or")![1][0] as string;
    for (const col of ["raised_at", "decided_at", "implemented_at"]) {
      expect(orFilter).toContain(`${col}.gte.2026-10-01T00:00:00Z`);
    }
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({
      action: "export.csv",
      after: expect.objectContaining({ entity: "change_requests", row_count: 2 }),
    });
  });

  it("stays readable when the wave-2 columns are absent (blank = not recorded)", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["change:read"]));
    seed();
    errors.change_requests = { column: "implemented_at", message: "column change_requests.implemented_at does not exist", code: "42703" };
    errors.documents = { column: "change_request_id", message: "column documents.change_request_id does not exist", code: "42703" };
    errors.decisions = { column: "change_request_id", message: "column decisions.change_request_id does not exist", code: "42703" };
    const res = await call("?entity=change_requests");
    expect(res.status).toBe(200);
    const [, first] = lines(await res.text());
    expect(first).toContain("CR-001");
    expect(first).not.toContain(",0,0,0,");
    expect(queried.filter((q) => q.table === "change_requests")).toHaveLength(2);
    // the retry without implemented_at must not still filter on it
    const retry = queried.filter((q) => q.table === "change_requests")[1];
    expect(retry.ops.find(([op]) => op === "or")?.[1][0] ?? "").not.toContain("implemented_at");
  });

  it("does not swallow an unrelated error that merely mentions a column", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["change:read"]));
    seed();
    errors.documents = { column: "change_request_id", message: "permission denied for column change_request_id" };
    expect((await call("?entity=change_requests")).status).toBe(500);
  });

  it("chunks the evidence and decision lookups by 100 ids", async () => {
    requireAuthMock.mockResolvedValueOnce(token(["change:read"]));
    tables.change_requests = Array.from({ length: 250 }, (_, i) => ({ id: "c" + i, status: "raised", reference_id: "CR-" + i }));
    await call("?entity=change_requests");
    for (const table of ["documents", "decisions"]) {
      const qs = queried.filter((q) => q.table === table);
      expect(qs).toHaveLength(3);
      for (const q of qs) {
        const ids = q.ops.find(([op]) => op === "in")![1][1] as string[];
        expect(ids.length).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("GET /api/export?entity=audit_pack", () => {
  for (const [label, actor] of [
    ["a token holding every scope", token(["*"])],
    ["a member session", session("member")],
    ["a viewer session", session("viewer")],
  ] as const) {
    it(`403s ${label} and reads nothing`, async () => {
      requireAuthMock.mockResolvedValueOnce(actor);
      const res = await call("?entity=audit_pack&format=csv");
      expect(res.status).toBe(403);
      expect(queried).toHaveLength(0);
      expect(writeAuditMock).not.toHaveBeenCalled();
    });
  }

  it("rejects an unknown format with 422", async () => {
    requireAuthMock.mockResolvedValueOnce(session("admin"));
    expect((await call("?entity=audit_pack&format=xml")).status).toBe(422);
  });

  it("CSV: one file with all four sections, the range applied, and an export.audit_pack audit row", async () => {
    requireAuthMock.mockResolvedValueOnce(session("manager"));
    seed();
    const res = await call("?entity=audit_pack&from=2026-10-01&to=2026-10-31&format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("nopm-audit-pack-2026-10-18.csv");
    const rows = lines(await res.text());
    expect(rows[0].startsWith("section,id,ref,")).toBe(true);
    const sections = rows.slice(1).map((r) => r.split(",")[0]);
    expect(sections).toEqual(["change_requests", "change_requests", "evidence", "evidence", "decisions", "approvals_audit"]);
    expect(rows.find((r) => r.startsWith("evidence,d1"))).toContain("UAT sign-off");
    expect(rows.find((r) => r.startsWith("approvals_audit"))).toContain("change_request.decide");
    expect(rows.find((r) => r.startsWith("approvals_audit"))).toContain("Lee Implementer");

    // range: change requests selected by raised OR decided inside the range; audit rows by created_at
    const crQuery = queried.find((q) => q.table === "change_requests")!;
    const orFilter = crQuery.ops.find(([op]) => op === "or")![1][0] as string;
    expect(orFilter).toContain("raised_at.gte.2026-10-01T00:00:00Z");
    expect(orFilter).toContain("decided_at.lt.2026-11-01T00:00:00.000Z");
    const auditQuery = queried.find((q) => q.table === "audit_log")!;
    expect(auditQuery.ops).toContainEqual(["like", ["action", "change_request.%"]]);
    expect(auditQuery.ops.find(([op]) => op === "in")![1]).toEqual(["target_id", ["cr1", "cr2"]]);
    for (const q of queried.filter((x) => ["change_requests", "documents", "decisions", "audit_log"].includes(x.table))) {
      expect(q.ops).toContainEqual(["eq", ["workspace_id", "ws-1"]]);
    }

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({
      action: "export.audit_pack",
      after: expect.objectContaining({
        format: "csv",
        filters: { from: "2026-10-01", to: "2026-10-31" },
        row_counts: { change_requests: 2, evidence: 2, decisions: 1, approvals_audit: 1 },
      }),
    });
  });

  it("CSV: an older schema is marked not available, never silently empty", async () => {
    requireAuthMock.mockResolvedValueOnce(session("admin"));
    seed();
    errors.documents = { column: "change_request_id", message: "column documents.change_request_id does not exist", code: "42703" };
    errors.decisions = { column: "change_request_id", message: "column decisions.change_request_id does not exist", code: "42703" };
    const rows = lines(await (await call("?entity=audit_pack")).text());
    expect(rows.some((r) => r.startsWith("evidence,") && r.includes("not available (schema older than 0093/0094)"))).toBe(true);
    expect(rows.some((r) => r.startsWith("decisions,") && r.includes("not available (schema older than 0093/0094)"))).toBe(true);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ after: expect.objectContaining({ unavailable: { evidence: true, decisionLinks: true } }) });
  });

  it("CSV: an implemented request still shows the approve verb in the pack", async () => {
    requireAuthMock.mockResolvedValueOnce(session("admin"));
    seed();
    const rows = lines(await (await call("?entity=audit_pack")).text());
    const cr1 = rows.find((r) => r.startsWith("change_requests,cr1"))!;
    expect(cr1).toContain(",implemented,");
    expect(cr1).toContain(",approve,Vendor slip,");
  });

  it("PDF: returns a PDF for an admin and audits the pdf format", async () => {
    requireAuthMock.mockResolvedValueOnce(session("admin"));
    seed();
    const res = await call("?entity=audit_pack&format=pdf&from=2026-10-01");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({
      action: "export.audit_pack",
      after: expect.objectContaining({ format: "pdf" }),
    });
  });

  it("an empty workspace still yields a valid one-line CSV header and a PDF", async () => {
    requireAuthMock.mockResolvedValueOnce(session("admin"));
    const csv = await call("?entity=audit_pack");
    expect(lines(await csv.text())).toHaveLength(1);
    requireAuthMock.mockResolvedValueOnce(session("admin"));
    const pdf = await call("?entity=audit_pack&format=pdf");
    expect(new TextDecoder().decode(new Uint8Array(await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
  });
});
