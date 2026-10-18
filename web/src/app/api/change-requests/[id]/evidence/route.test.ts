/**
 * R-171: POST /api/change-requests/:id/evidence. Real handler against the in-memory admin client holding two workspaces.
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

import { POST, GET } from "./route";

const W1 = "ws-1";
const W2 = "ws-2";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const P1 = "44444444-4444-4444-8444-444444444441";
const P1B = "44444444-4444-4444-8444-444444444443";
const P2 = "44444444-4444-4444-8444-444444444442";
const CR_OPEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CR_OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const CR_REJECTED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
const CR_DEFERRED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6";
const CR_FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const DOC_FREE = "99999999-9999-4999-8999-999999999991";
const DOC_P1B = "99999999-9999-4999-8999-999999999992";
const DOC_ELSEWHERE = "99999999-9999-4999-8999-999999999993";
const DOC_FOREIGN = "99999999-9999-4999-8999-999999999994";

let db: FakeDb;

function setActor(over: Partial<Actor> = {}) {
  authHolder.actor = {
    type: "user", id: ADMIN, label: "Admin", workspaceId: W1, role: "admin", principalId: ADMIN, channel: "ui", requestId: "r1", ...over,
  } as Actor;
}

type H = (req: NextRequest, ctx: { params?: Promise<Record<string, string>> }) => Promise<Response>;
async function call(h: unknown, method: "GET" | "POST", body: unknown, id: string) {
  const req = new NextRequest("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (h as H)(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  setActor();
  db = new FakeDb({
    projects: [
      { id: P1, workspace_id: W1, name: "Billing" },
      { id: P1B, workspace_id: W1, name: "Other" },
      { id: P2, workspace_id: W2, name: "Foreign" },
    ],
    profiles: [{ id: ADMIN, workspace_id: W1, role: "admin" }],
    change_requests: [
      { id: CR_OPEN, workspace_id: W1, project_id: P1, title: "Rename", status: "approved" },
      { id: CR_OTHER, workspace_id: W1, project_id: P1, title: "Second", status: "raised" },
      { id: CR_REJECTED, workspace_id: W1, project_id: P1, title: "No", status: "rejected" },
      { id: CR_DEFERRED, workspace_id: W1, project_id: P1, title: "Later", status: "deferred" },
      { id: CR_FOREIGN, workspace_id: W2, project_id: P2, title: "Foreign CR", status: "approved" },
    ],
    documents: [
      { id: DOC_FREE, workspace_id: W1, project_id: P1, title: "Plan", version: 1, body: null, status: "draft", change_request_id: null },
      { id: DOC_P1B, workspace_id: W1, project_id: P1B, title: "Other project doc", version: 1, status: "draft", change_request_id: null },
      { id: DOC_ELSEWHERE, workspace_id: W1, project_id: P1, title: "Run", version: 1, status: "draft", change_request_id: CR_OTHER, evidence_type: "test_result" },
      { id: DOC_FOREIGN, workspace_id: W2, project_id: P2, title: "Foreign doc", version: 1, status: "draft", change_request_id: null },
    ],
  });
  holder.db = db;
});

const lastAudit = () => db.rows("audit_log").at(-1) as { action: string; after: Record<string, unknown> } | undefined;

describe("POST new evidence document", () => {
  it("creates a document under the request's project, one document.create audit row, 201", async () => {
    const res = await call(POST, "POST", { title: "Regression run", evidence_type: "test_result", evidence_result: "pass", tested_by: "QA bot", evidence_note: "all green" }, CR_OPEN);
    expect(res.status, await res.clone().text()).toBe(201);
    const row = (await res.json()).data;
    expect(row.project_id).toBe(P1);
    expect(row.change_request_id).toBe(CR_OPEN);
    expect(row.evidence_type).toBe("test_result");
    expect(row.evidence_result).toBe("pass");
    expect(row.tested_by_label).toBe("QA bot");
    expect(row.tested_at).toBeTruthy();
    expect(row.status).toBe("draft");
    expect(row.doc_type).toBe("other");
    expect(String(row.reference_id)).toMatch(/^DOC-/);
    expect(db.rows("audit_log")).toHaveLength(1);
    expect(lastAudit()!.action).toBe("document.create");
    expect(lastAudit()!.after.change_request_id).toBe(CR_OPEN);
  });

  it("defaults the tester to the caller's label", async () => {
    const res = await call(POST, "POST", { title: "Run", evidence_type: "deploy_record" }, CR_OPEN);
    expect((await res.json()).data.tested_by_label).toBe("Admin");
  });

  it("takes an emergency, raised, under_review and implemented request too", async () => {
    for (const [i, status] of ["raised", "under_review", "emergency", "implemented"].entries()) {
      const id = `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${i}`;
      db.rows("change_requests").push({ id, workspace_id: W1, project_id: P1, title: status, status });
      const res = await call(POST, "POST", { title: `Run ${status}`, evidence_type: "other" }, id);
      expect(res.status, status).toBe(201);
    }
  });
});

describe("POST link an existing document", () => {
  it("links it, returns 200, writes one document.update audit row", async () => {
    const res = await call(POST, "POST", { document_id: DOC_FREE, evidence_type: "uat_signoff", evidence_result: "pass" }, CR_OPEN);
    expect(res.status, await res.clone().text()).toBe(200);
    const row = (await res.json()).data;
    expect(row.change_request_id).toBe(CR_OPEN);
    expect(row.evidence_type).toBe("uat_signoff");
    expect(db.rows("audit_log")).toHaveLength(1);
    expect(lastAudit()!.action).toBe("document.update");
    expect(lastAudit()!.after.change_request_id).toBe(CR_OPEN);
  });

  it("refuses a document from a different project (422 evidence_link_invalid)", async () => {
    const res = await call(POST, "POST", { document_id: DOC_P1B, evidence_type: "other" }, CR_OPEN);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("evidence_link_invalid");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("refuses a document that is already evidence for another request (422 evidence_linked_elsewhere)", async () => {
    const res = await call(POST, "POST", { document_id: DOC_ELSEWHERE, evidence_type: "other" }, CR_OPEN);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("evidence_linked_elsewhere");
    expect(db.rows("documents").find((d) => d.id === DOC_ELSEWHERE)!.change_request_id).toBe(CR_OTHER);
  });

  it("404s for a document in another workspace", async () => {
    const res = await call(POST, "POST", { document_id: DOC_FOREIGN, evidence_type: "other" }, CR_OPEN);
    expect(res.status).toBe(404);
    expect(db.rows("audit_log")).toHaveLength(0);
  });
});

describe("state, workspace and scope", () => {
  it("422 evidence_not_accepted for a rejected or deferred request, nothing written", async () => {
    for (const id of [CR_REJECTED, CR_DEFERRED]) {
      const res = await call(POST, "POST", { title: "Run", evidence_type: "other" }, id);
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe("evidence_not_accepted");
    }
    expect(db.rows("documents")).toHaveLength(4);
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("404s for another workspace's change request", async () => {
    const res = await call(POST, "POST", { title: "Run", evidence_type: "other" }, CR_FOREIGN);
    expect(res.status).toBe(404);
    expect(db.rows("documents")).toHaveLength(4);
  });

  it("a token without document:write gets 403 and nothing is read or written", async () => {
    setActor({ type: "token", scopes: ["document:read"] } as Partial<Actor>);
    const res = await call(POST, "POST", { title: "Run", evidence_type: "other" }, CR_OPEN);
    expect(res.status).toBe(403);
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("a token with document:write is workspace-filtered", async () => {
    setActor({ type: "token", scopes: ["document:write"] } as Partial<Actor>);
    const ok = await call(POST, "POST", { title: "Run", evidence_type: "other" }, CR_OPEN);
    expect(ok.status, await ok.clone().text()).toBe(201);
    const foreign = await call(POST, "POST", { title: "Run", evidence_type: "other" }, CR_FOREIGN);
    expect(foreign.status).toBe(404);
  });
});

describe("validation (422 with fields)", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["neither document_id nor title", { evidence_type: "other" }],
    ["both document_id and title", { document_id: DOC_FREE, title: "x", evidence_type: "other" }],
    ["no evidence_type", { title: "x" }],
    ["unknown evidence_type", { title: "x", evidence_type: "vibes" }],
    ["unknown evidence_result", { title: "x", evidence_type: "other", evidence_result: "great" }],
    ["a bad tested_at", { title: "x", evidence_type: "other", tested_at: "yesterday" }],
    ["new-document fields next to document_id", { document_id: DOC_FREE, body: "x", evidence_type: "other" }],
    ["an unknown key", { title: "x", evidence_type: "other", change_request_id: CR_OTHER }],
  ];
  for (const [name, body] of cases) {
    it(`rejects ${name}`, async () => {
      const res = await call(POST, "POST", body, CR_OPEN);
      expect(res.status).toBe(422);
      expect(db.rows("audit_log")).toHaveLength(0);
    });
  }
});

describe("GET still lists the evidence", () => {
  it("returns what POST attached", async () => {
    await call(POST, "POST", { title: "Run", evidence_type: "test_result" }, CR_OPEN);
    const res = await call(GET, "GET", undefined, CR_OPEN);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
  });
});

describe("W2-12 compare-and-set on linking", () => {
  it("a document linked to another request between the read and the write is refused, not moved", async () => {
    // Simulate the race: the document is free when read, taken by CR_OTHER before the write lands.
    const row = db.rows("documents").find((d) => d.id === DOC_FREE)!;
    row.updated_at = "2026-10-18T10:00:00Z";
    const real = db.client.from.bind(db.client);
    let raced = false;
    (db.client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = real(t) as { maybeSingle?: () => Promise<unknown> };
      if (t === "documents" && !raced && q.maybeSingle) {
        const orig = q.maybeSingle.bind(q);
        q.maybeSingle = async () => {
          const out = await orig();
          if (!raced) {
            raced = true;
            row.change_request_id = CR_OTHER;
            row.updated_at = "2026-10-18T10:00:05Z";
          }
          return out;
        };
      }
      return q;
    };
    const res = await call(POST, "POST", { document_id: DOC_FREE, evidence_type: "other" }, CR_OPEN);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("evidence_linked_elsewhere");
    expect(row.change_request_id).toBe(CR_OTHER);
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("re-attaching a document already linked to this same request still works", async () => {
    const res = await call(POST, "POST", { document_id: DOC_ELSEWHERE, evidence_type: "uat_signoff" }, CR_OTHER);
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

describe("W2-13 tester is the acting person", () => {
  it("an admin session may name the tester", async () => {
    const res = await call(POST, "POST", { title: "Run", evidence_type: "uat_signoff", tested_by: "Dana Lee" }, CR_OPEN);
    expect((await res.json()).data.tested_by_label).toBe("Dana Lee");
  });

  it("a token cannot name someone else: tester is the token label, the claim goes to the note", async () => {
    setActor({ type: "token", label: "ci-agent", scopes: ["document:write"] } as Partial<Actor>);
    const res = await call(POST, "POST", { title: "Run", evidence_type: "uat_signoff", tested_by: "Dana Lee", evidence_note: "ran suite" }, CR_OPEN);
    expect(res.status, await res.clone().text()).toBe(201);
    const row = (await res.json()).data;
    expect(row.tested_by_label).toBe("ci-agent");
    expect(row.evidence_note).toContain("ran suite");
    expect(row.evidence_note).toContain("Dana Lee");
    expect(row.evidence_note).toContain("not verified");
  });

  it("a member session cannot name someone else either", async () => {
    setActor({ role: "member", label: "Mo" } as Partial<Actor>);
    const res = await call(POST, "POST", { title: "Run", evidence_type: "other", tested_by: "Dana Lee" }, CR_OPEN);
    const row = (await res.json()).data;
    expect(row.tested_by_label).toBe("Mo");
    expect(row.evidence_note).toContain("Dana Lee");
  });

  it("naming yourself adds no claim note", async () => {
    setActor({ type: "token", label: "ci-agent", scopes: ["document:write"] } as Partial<Actor>);
    const res = await call(POST, "POST", { title: "Run", evidence_type: "other", tested_by: "ci-agent" }, CR_OPEN);
    expect((await res.json()).data.evidence_note).toBeNull();
  });
});
