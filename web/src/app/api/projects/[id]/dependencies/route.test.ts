/**
 * Project dependencies (R-147, audit item B5): GET/POST /api/projects/:id/dependencies,
 * DELETE /api/projects/:id/dependencies/:depId and GET /api/projects/:id/contingency.
 * The routes run for real over the in-memory governed database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
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

import { GET, POST } from "./route";
import { DELETE } from "./[depId]/route";
import { GET as CONTINGENCY } from "../contingency/route";

const WS = "ws-1";
const OTHER_WS = "ws-2";
const ALICE = "11111111-1111-4111-8111-111111111111";
// Project ids are real UUIDs: the route validates the body field as a UUID.
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOREIGN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RISK_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RISK_OTHER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const RISK_FOREIGN = "99999999-9999-4999-8999-999999999999";

const actor = (role: string): Actor => ({
  type: "user",
  id: ALICE,
  label: "alice",
  workspaceId: WS,
  role,
  principalId: ALICE,
  channel: "ui",
  requestId: "req-1",
});

let db: FakeDb;
const deps = () => db.rows("project_dependencies");
const audits = () => db.rows("audit_log");

const ctx = (id: string, depId?: string) => ({
  params: Promise.resolve<Record<string, string>>(depId ? { id, depId } : { id }),
});
const req = (path: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

const add = (id: string, body: unknown, who: Actor = actor("manager")) => {
  authHolder.actor = who;
  return POST(req(`/api/projects/${id}/dependencies`, "POST", body), ctx(id));
};

beforeEach(() => {
  db = new FakeDb({
    projects: [
      { id: A, workspace_id: WS, code: "AAA", name: "Alpha", rag_status: "green" },
      { id: B, workspace_id: WS, code: "BBB", name: "Beta", rag_status: "amber" },
      { id: C, workspace_id: WS, code: "CCC", name: "Gamma", rag_status: "red" },
      { id: FOREIGN, workspace_id: OTHER_WS, code: "ZZZ", name: "Elsewhere", rag_status: "red" },
    ],
    risks: [
      { id: RISK_A, workspace_id: WS, project_id: A, title: "Vendor slips" },
      { id: RISK_OTHER, workspace_id: WS, project_id: C, title: "Unrelated" },
      { id: RISK_FOREIGN, workspace_id: OTHER_WS, project_id: FOREIGN, title: "Foreign" },
    ],
    project_dependencies: [],
    audit_log: [],
  });
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/projects/:id/dependencies", () => {
  it("adds a dependency, returns 201 and writes ONE audit row with before null and the row as after", async () => {
    const res = await add(A, { depends_on_project_id: B, kind: "delivery", note: "needs the API" });
    expect(res.status).toBe(201);
    const row = (await res.json()).data;
    expect(row).toMatchObject({
      workspace_id: WS,
      project_id: A,
      depends_on_project_id: B,
      kind: "delivery",
      note: "needs the API",
      created_by: ALICE,
    });
    expect(deps()).toHaveLength(1);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      action: "project.dependency.add",
      target_type: "project",
      target_id: A,
      before: null,
      after: expect.objectContaining({ depends_on_project_id: B, kind: "delivery" }),
    });
  });

  it("accepts a linked risk that belongs to either project", async () => {
    const res = await add(A, { depends_on_project_id: B, kind: "risk", linked_risk_id: RISK_A });
    expect(res.status).toBe(201);
    expect(deps()[0].linked_risk_id).toBe(RISK_A);
  });

  it("refuses a linked risk from a third project (422) and writes nothing", async () => {
    const res = await add(A, { depends_on_project_id: B, kind: "risk", linked_risk_id: RISK_OTHER });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("risk_not_in_projects");
    expect(deps()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it("refuses a linked risk from another workspace (422)", async () => {
    const res = await add(A, { depends_on_project_id: B, kind: "risk", linked_risk_id: RISK_FOREIGN });
    expect(res.status).toBe(422);
    expect(deps()).toHaveLength(0);
  });

  it("refuses a self-dependency (422, self_dependency)", async () => {
    const res = await add(A, { depends_on_project_id: A, kind: "delivery" });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("self_dependency");
    expect(audits()).toHaveLength(0);
  });

  it("refuses a project from another workspace (422) without saying whether it exists", async () => {
    const foreign = await add(A, { depends_on_project_id: FOREIGN, kind: "delivery" });
    const missing = await add(A, { depends_on_project_id: "12345678-1234-4234-8234-123456789012", kind: "delivery" });
    expect(foreign.status).toBe(422);
    expect(missing.status).toBe(422);
    expect((await foreign.json()).fields[0].message).toBe((await missing.json()).fields[0].message);
    expect(deps()).toHaveLength(0);
  });

  it("answers 404 when the path project is in another workspace", async () => {
    const res = await add(FOREIGN, { depends_on_project_id: A, kind: "delivery" });
    expect(res.status).toBe(404);
    expect(deps()).toHaveLength(0);
  });

  it("refuses a cycle A -> B -> A (422, circular_dependency) and a longer loop", async () => {
    expect((await add(A, { depends_on_project_id: B, kind: "delivery" })).status).toBe(201);
    const back = await add(B, { depends_on_project_id: A, kind: "resource" });
    expect(back.status).toBe(422);
    expect((await back.json()).code).toBe("circular_dependency");

    expect((await add(B, { depends_on_project_id: C, kind: "delivery" })).status).toBe(201);
    const loop = await add(C, { depends_on_project_id: A, kind: "decision" });
    expect(loop.status).toBe(422);
    expect(deps()).toHaveLength(2);
    expect(audits()).toHaveLength(2);
  });

  it("refuses the same link twice (409, duplicate_dependency) but allows another kind", async () => {
    expect((await add(A, { depends_on_project_id: B, kind: "delivery" })).status).toBe(201);
    const dup = await add(A, { depends_on_project_id: B, kind: "delivery" });
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe("duplicate_dependency");
    expect((await add(A, { depends_on_project_id: B, kind: "resource" })).status).toBe(201);
    expect(deps()).toHaveLength(2);
  });

  it("validates the body (422 with fields)", async () => {
    const res = await add(A, { depends_on_project_id: "nope", kind: "weekly" });
    expect(res.status).toBe(422);
    const fields = (await res.json()).fields.map((f: { field: string }) => f.field);
    expect(fields).toEqual(expect.arrayContaining(["depends_on_project_id", "kind"]));
  });

  it("still works on a locked project: a project dependency does not reshape the locked schedule", async () => {
    db.rows("projects").find((p) => p.id === A)!.is_locked = true;
    const res = await add(A, { depends_on_project_id: B, kind: "delivery" });
    expect(res.status).toBe(201);
  });

  it("is write-scoped: a viewer gets 403 and nothing is written", async () => {
    const res = await add(A, { depends_on_project_id: B, kind: "delivery" }, actor("viewer"));
    expect(res.status).toBe(403);
    expect(deps()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });
});

describe("GET /api/projects/:id/dependencies", () => {
  it("lists both directions with the other project's code, name and RAG, workspace-filtered", async () => {
    await add(A, { depends_on_project_id: B, kind: "delivery" });
    await add(C, { depends_on_project_id: A, kind: "resource" });
    authHolder.actor = actor("viewer"); // read scope is enough
    const res = await GET(req(`/api/projects/${A}/dependencies`), ctx(A));
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data).toHaveLength(2);
    expect(data.find((d: { direction: string }) => d.direction === "depends_on").other_project).toMatchObject({ id: B, code: "BBB", rag_status: "amber" });
    expect(data.find((d: { direction: string }) => d.direction === "depended_on_by").other_project).toMatchObject({ id: C, code: "CCC", rag_status: "red" });
  });

  it("does not show another workspace's edges", async () => {
    deps().push({ id: "x", workspace_id: OTHER_WS, project_id: A, depends_on_project_id: B, kind: "delivery", created_at: "2026-01-01" });
    authHolder.actor = actor("member");
    const res = await GET(req(`/api/projects/${A}/dependencies`), ctx(A));
    expect((await res.json()).data).toHaveLength(0);
  });
});

describe("DELETE /api/projects/:id/dependencies/:depId", () => {
  it("removes it, returns 204 and writes ONE audit row with the row as before", async () => {
    const row = (await (await add(A, { depends_on_project_id: B, kind: "delivery" })).json()).data;
    audits().length = 0;
    authHolder.actor = actor("manager");
    const res = await DELETE(req(`/api/projects/${A}/dependencies/${row.id}`, "DELETE"), ctx(A, row.id));
    expect(res.status).toBe(204);
    expect(deps()).toHaveLength(0);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      action: "project.dependency.remove",
      target_id: A,
      before: expect.objectContaining({ id: row.id, depends_on_project_id: B }),
      after: null,
    });
  });

  it("404s for an unknown id, an id under another project, and a viewer is refused (403)", async () => {
    const row = (await (await add(A, { depends_on_project_id: B, kind: "delivery" })).json()).data;
    audits().length = 0;
    authHolder.actor = actor("manager");
    expect((await DELETE(req("/x", "DELETE"), ctx(A, "nope"))).status).toBe(404);
    expect((await DELETE(req("/x", "DELETE"), ctx(C, row.id))).status).toBe(404);
    authHolder.actor = actor("viewer");
    expect((await DELETE(req("/x", "DELETE"), ctx(A, row.id))).status).toBe(403);
    expect(deps()).toHaveLength(1);
    expect(audits()).toHaveLength(0);
  });
});

describe("GET /api/projects/:id/contingency", () => {
  it("flags a green project that depends (through an amber one) on a red one, with the chain", async () => {
    await add(A, { depends_on_project_id: B, kind: "delivery" });
    await add(B, { depends_on_project_id: C, kind: "delivery" });
    authHolder.actor = actor("viewer");
    const res = await CONTINGENCY(req(`/api/projects/${A}/contingency`), ctx(A));
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data).toMatchObject({ declared_rag: "green", worst_dependency_rag: "red", contingent_on_red: true });
    expect(data.chain.map((c: { code: string }) => c.code)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("is not contingent without a red dependency, and never changes the stored RAG", async () => {
    await add(C, { depends_on_project_id: B, kind: "delivery" });
    authHolder.actor = actor("member");
    const data = (await (await CONTINGENCY(req(`/api/projects/${C}/contingency`), ctx(C))).json()).data;
    expect(data).toMatchObject({ declared_rag: "red", worst_dependency_rag: "amber", contingent_on_red: false, chain: [] });
    expect(db.rows("projects").find((p) => p.id === A)!.rag_status).toBe("green");
  });

  it("404s for a project in another workspace", async () => {
    authHolder.actor = actor("member");
    expect((await CONTINGENCY(req("/x"), ctx(FOREIGN))).status).toBe(404);
  });
});
