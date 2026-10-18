/**
 * M4 / R-137: test and UAT evidence attached to a change request, at the HTTP edge.
 * Real route handlers against the in-memory admin client holding two workspaces.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (holder.db as FakeDb).client }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth/mfa", () => ({
  MFA_COOKIE_NAME: "nopm_mfa",
  getMfaEnrollmentStatus: async () => ({ enabled: false, enr: null }),
  verifyMfaCookie: () => false,
}));
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireAuth: async () => authHolder.actor as Actor };
});

import { POST as createDocument, GET as listDocuments } from "./route";
import { PATCH as patchDocument } from "./[id]/route";
import { GET as listEvidence } from "../change-requests/[id]/evidence/route";

const W1 = "ws-1";
const W2 = "ws-2";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const P1 = "44444444-4444-4444-8444-444444444441";
const P1B = "44444444-4444-4444-8444-444444444443";
const P2 = "44444444-4444-4444-8444-444444444442";
const CR1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CR1_OTHER_PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const CR2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const DOC = "99999999-9999-4999-8999-999999999993";

let db: FakeDb;

function actor(): Actor {
  return { type: "user", id: ADMIN, label: "Admin", workspaceId: W1, role: "admin", principalId: ADMIN, channel: "ui", requestId: "r1" };
}

type H = (req: NextRequest, ctx: { params?: Promise<Record<string, string>> }) => Promise<Response>;
async function call(h: H, method: "GET" | "POST" | "PATCH", body?: unknown, params: Record<string, string> = {}, qs = "") {
  const req = new NextRequest(`http://localhost/api/x${qs}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return h(req, { params: Promise.resolve(params) });
}

beforeEach(() => {
  db = new FakeDb({
    projects: [
      { id: P1, workspace_id: W1, name: "Billing" },
      { id: P1B, workspace_id: W1, name: "Other" },
      { id: P2, workspace_id: W2, name: "Foreign" },
    ],
    profiles: [{ id: ADMIN, workspace_id: W1, role: "admin" }],
    change_requests: [
      { id: CR1, workspace_id: W1, project_id: P1, title: "Rename" },
      { id: CR1_OTHER_PROJECT, workspace_id: W1, project_id: P1B, title: "Other project" },
      { id: CR2, workspace_id: W2, project_id: P2, title: "Foreign CR" },
    ],
    documents: [
      { id: DOC, workspace_id: W1, project_id: P1, title: "Plan", version: 1, body: null, status: "draft", change_request_id: null },
      { id: "d-a", workspace_id: W1, project_id: P1, title: "Run A", change_request_id: CR1, evidence_type: "test_result", evidence_result: "pass", tested_at: "2026-10-01T00:00:00Z" },
      { id: "d-b", workspace_id: W1, project_id: P1, title: "Run B", change_request_id: CR1, evidence_type: "uat_signoff", evidence_result: "fail", tested_at: "2026-10-02T00:00:00Z" },
      { id: "d-x", workspace_id: W2, project_id: P2, title: "Foreign run", change_request_id: CR1, evidence_type: "test_result", evidence_result: "pass" },
    ],
  });
  holder.db = db;
  authHolder.actor = actor();
});

const lastAudit = () => db.rows("audit_log").at(-1) as { action: string; after: Record<string, unknown> } | undefined;

describe("link validation (422)", () => {
  it("refuses a change request from another workspace and writes nothing", async () => {
    const before = db.rows("documents").length;
    const res = await call(createDocument as H, "POST", { title: "E", doc_type: "other", project_id: P1, change_request_id: CR2, evidence_type: "test_result" });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("invalid_reference");
    expect(db.rows("documents")).toHaveLength(before);
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("refuses a change request that belongs to a different project", async () => {
    const res = await call(createDocument as H, "POST", { title: "E", doc_type: "other", project_id: P1, change_request_id: CR1_OTHER_PROJECT });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("evidence_link_invalid");
    expect(body.fields[0].field).toBe("change_request_id");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("refuses a patch that moves a linked document to another project", async () => {
    const res = await call(patchDocument as H, "PATCH", { project_id: P1B }, { id: "d-a" });
    expect(res.status).toBe(422);
    expect(db.rows("documents").find((d) => d.id === "d-a")!.project_id).toBe(P1);
  });

  it("refuses evidence fields without a change request", async () => {
    const res = await call(createDocument as H, "POST", { title: "E", doc_type: "other", evidence_type: "test_result" });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("evidence_needs_change_request");
  });

  it("refuses a result without a type", async () => {
    const res = await call(createDocument as H, "POST", { title: "E", doc_type: "other", project_id: P1, change_request_id: CR1, evidence_result: "pass" });
    expect(res.status).toBe(422);
  });

  it("refuses unknown evidence type and result values", async () => {
    const a = await call(createDocument as H, "POST", { title: "E", doc_type: "other", project_id: P1, change_request_id: CR1, evidence_type: "vibes" });
    const b = await call(createDocument as H, "POST", { title: "E", doc_type: "other", project_id: P1, change_request_id: CR1, evidence_type: "test_result", evidence_result: "great" });
    expect(a.status).toBe(422);
    expect(b.status).toBe(422);
  });
});

describe("create and update write exactly one audit row carrying change_request_id", () => {
  it("POST: stores the evidence, defaults tester and time, audit after has the link", async () => {
    const res = await call(createDocument as H, "POST", { title: "Run C", doc_type: "other", project_id: P1, change_request_id: CR1, evidence_type: "test_result", evidence_result: "pass" });
    expect(res.status, await res.clone().text()).toBe(201);
    const row = (await res.json()).data;
    expect(row.change_request_id).toBe(CR1);
    expect(row.tested_by_label).toBe("Admin");
    expect(row.tested_at).toBeTruthy();
    expect(db.rows("audit_log")).toHaveLength(1);
    expect(lastAudit()!.action).toBe("document.create");
    expect(lastAudit()!.after.change_request_id).toBe(CR1);
    expect(lastAudit()!.after.evidence_result).toBe("pass");
  });

  it("PATCH: linking an existing document audits the new link", async () => {
    const res = await call(patchDocument as H, "PATCH", { change_request_id: CR1, evidence_type: "deploy_record", evidence_result: "n/a" }, { id: DOC });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(db.rows("audit_log")).toHaveLength(1);
    expect(lastAudit()!.action).toBe("document.update");
    expect(lastAudit()!.after.change_request_id).toBe(CR1);
  });

  it("PATCH: unlinking clears the evidence fields", async () => {
    const res = await call(patchDocument as H, "PATCH", { change_request_id: null }, { id: "d-a" });
    expect(res.status, await res.clone().text()).toBe(200);
    const row = (await res.json()).data;
    expect(row.change_request_id).toBeNull();
    expect(row.evidence_type).toBeNull();
    expect(row.evidence_result).toBeNull();
  });
});

describe("GET /api/change-requests/:id/evidence", () => {
  it("lists only this workspace's documents linked to the request", async () => {
    const res = await call(listEvidence as H, "GET", undefined, { id: CR1 });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.map((d: { id: string }) => d.id).sort();
    expect(ids).toEqual(["d-a", "d-b"]);
    expect(ids).not.toContain("d-x");
  });

  it("404s for a change request in another workspace", async () => {
    const res = await call(listEvidence as H, "GET", undefined, { id: CR2 });
    expect(res.status).toBe(404);
  });

  it("the documents list can filter by change_request_id", async () => {
    const res = await call(listDocuments as H, "GET", undefined, {}, `?change_request_id=${CR1}`);
    const body = await res.json();
    expect(body.data.map((d: { id: string }) => d.id).sort()).toEqual(["d-a", "d-b"]);
  });
});
