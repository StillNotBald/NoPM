/**
 * G8 (audit gap, migration 0102): deletion is a REQUEST for risks, issues, expenses, documents and
 * milestones, like tasks and projects. Drives the real route handlers with an in-memory admin client
 * (requireAuth mocked, requireScope real):
 *
 *   - DELETE raises a pending request and answers 202; the record is still there;
 *   - the approve/reject/withdraw verbs under /api/deletion-requests dispatch by target type;
 *   - the requester cannot approve their own request, a manager can, the commit RPC gets the principal;
 *   - milestone and approved-document rules; the legacy risk:delete / issue:delete scopes now mean "request".
 *
 * The SQL itself (the commit RPCs and the BEFORE DELETE backstop) is asserted in
 * lib/governance/deletion-by-request-migration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";
import { installAtomicGovernance } from "@/lib/governance/test-support/fake-atomic-governance";
import { AGENT_PRESET_SCOPES } from "@/lib/auth/scopes";

const { holder, emitted, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  emitted: { requested: [] as Record<string, unknown>[], decided: [] as Record<string, unknown>[] },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: (ev: Record<string, unknown>) => void emitted.requested.push(ev),
  emitApprovalDecided: (ev: Record<string, unknown>) => void emitted.decided.push(ev),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth/mfa", () => ({
  MFA_COOKIE_NAME: "nopm_mfa",
  getMfaEnrollmentStatus: async () => ({ enabled: false, enr: null }),
  verifyMfaCookie: () => false,
}));
vi.mock("@/lib/governance/project-files", () => ({ removeStoredFiles: async () => undefined }));
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireAuth: async () => authHolder.actor as Actor };
});

import { DELETE as deleteRisk } from "./risks/[id]/route";
import { DELETE as deleteIssue } from "./issues/[id]/route";
import { DELETE as deleteExpense } from "./expenses/[id]/route";
import { DELETE as deleteDocument } from "./documents/[id]/route";
import { DELETE as deleteMilestone } from "./milestones/[id]/route";
import { POST as approve } from "./deletion-requests/[id]/approve/route";
import { POST as reject } from "./deletion-requests/[id]/reject/route";
import { POST as withdraw } from "./deletion-requests/[id]/withdraw/route";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CARA = "33333333-3333-4333-8333-333333333333";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const ENTITIES = [
  { entity: "risk", table: "risks", handler: deleteRisk, id: "risk-1", name: "title", label: "Vendor slips" },
  { entity: "issue", table: "issues", handler: deleteIssue, id: "issue-1", name: "title", label: "Login fails" },
  { entity: "expense", table: "expenses", handler: deleteExpense, id: "exp-1", name: "description", label: "Hotel" },
  { entity: "document", table: "documents", handler: deleteDocument, id: "doc-1", name: "title", label: "Charter" },
  { entity: "milestone", table: "milestones", handler: deleteMilestone, id: "ms-1", name: "name", label: "Go-live" },
] as const;

function session(id: string, role = "admin"): Actor {
  return { type: "user", id, label: id === ALICE ? "Alice" : "Bob", workspaceId: WS, role, principalId: id, principalRole: role, channel: "ui", requestId: `req-${id}` };
}

function pat(id: string, owner: string | null, scopes: string[], ownerRole = "manager"): Actor {
  return {
    type: "token",
    id,
    tokenId: id,
    label: `${id}-agent`,
    workspaceId: WS,
    scopes,
    principalId: owner,
    principalRole: owner ? ownerRole : null,
    channel: "api",
    requestId: `req-${id}`,
  };
}

const REQUEST_SCOPES = ENTITIES.map((e) => `${e.entity}:delete:request`);
const APPROVE_SCOPES = ENTITIES.map((e) => `${e.entity}:delete:approve`);
const alicePat = () => pat("tok-alice", ALICE, [...REQUEST_SCOPES, ...APPROVE_SCOPES], "admin");
const bobPat = () => pat("tok-bob", BOB, [...REQUEST_SCOPES, ...APPROVE_SCOPES]);

let db: FakeDb;

function seed(): FakeDb {
  return new FakeDb({
    projects: [
      { id: "proj-1", workspace_id: WS, name: "Billing Migration", is_locked: false },
      { id: "proj-locked", workspace_id: WS, name: "Frozen", is_locked: true },
    ],
    risks: [{ id: "risk-1", workspace_id: WS, project_id: "proj-1", title: "Vendor slips" }],
    issues: [{ id: "issue-1", workspace_id: WS, project_id: "proj-1", title: "Login fails" }],
    expenses: [{ id: "exp-1", workspace_id: WS, project_id: "proj-1", description: "Hotel", amount: 500 }],
    documents: [
      { id: "doc-1", workspace_id: WS, project_id: "proj-1", title: "Charter", status: "draft", storage_path: `${WS}/doc-1.pdf` },
      { id: "doc-ok", workspace_id: WS, project_id: "proj-1", title: "Signed charter", status: "approved", storage_path: null },
    ],
    milestones: [
      { id: "ms-1", workspace_id: WS, project_id: "proj-1", name: "Go-live" },
      { id: "ms-locked", workspace_id: WS, project_id: "proj-locked", name: "Frozen date" },
    ],
    tasks: [
      { id: "t1", workspace_id: WS, project_id: "proj-1", milestone_id: "ms-1", name: "A" },
      { id: "t2", workspace_id: WS, project_id: "proj-1", milestone_id: "ms-1", name: "B" },
    ],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "admin" },
      { id: BOB, workspace_id: WS, role: "manager" },
      { id: CARA, workspace_id: WS, role: "member" },
    ],
    deletion_requests: [],
    audit_log: [],
    notifications: [],
  });
}

function call(handler: Handler, actor: Actor, id: string, body?: unknown, method = "DELETE") {
  authHolder.actor = actor;
  const req = new NextRequest(`http://localhost/api/x/${id}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handler(req, { params: Promise.resolve({ id }) });
}

const auditActions = () => db.rows("audit_log").map((r) => r.action);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  db = installAtomicGovernance(seed());
  holder.db = db;
  emitted.requested.length = 0;
  emitted.decided.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("DELETE is the maker step: 202 and a pending request, never a delete", () => {
  it.each(ENTITIES)("$entity: raises a request, audits $entity.delete_requested, keeps the record", async (e) => {
    const res = await call(e.handler, session(ALICE), e.id, { reason: "duplicate" });
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(202);
    expect(json.data).toMatchObject({ target_type: e.entity, target_id: e.id, status: "pending", reason: "duplicate" });

    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(true);
    const req = db.rows("deletion_requests");
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({
      target_type: e.entity,
      requested_by_id: ALICE,
      requested_principal_id: ALICE,
      before: expect.objectContaining({ id: e.id, [e.name]: e.label }),
    });
    expect(auditActions()).toEqual([`${e.entity}.delete_requested`]);
    expect(emitted.requested).toHaveLength(1);
    expect(emitted.requested[0]).toMatchObject({ kind: `${e.entity}_deletion`, id: json.data.id, projectId: "proj-1" });
  });

  it.each(ENTITIES)("$entity: the request carries a tier and a decision deadline, and records deadline_set (W4-01)", async (e) => {
    const res = await call(e.handler, session(ALICE), e.id, { reason: "duplicate" });
    expect(res.status).toBe(202);
    const req = db.rows("deletion_requests")[0];
    expect(req.tier).toBe("normal");
    expect(typeof req.approval_deadline_at).toBe("string");
    expect(Date.parse(req.approval_deadline_at as string)).toBeGreaterThan(Date.now());
    const events = db.rows("approval_events");
    expect(events.some((x) => x.kind === "deadline_set" && x.target_id === req.id)).toBe(true);
    expect(emitted.requested[0]).toMatchObject({ tier: "normal" });
  });

  it("Q4: an approved document and a draft document are both on the manager tier (normal)", async () => {
    await call(deleteDocument, session(ALICE, "admin"), "doc-ok", { reason: "x" });
    await call(deleteDocument, session(ALICE, "admin"), "doc-1", { reason: "x" });
    const byTarget = Object.fromEntries(db.rows("deletion_requests").map((r) => [r.target_id as string, r.tier]));
    expect(byTarget["doc-ok"]).toBe("normal");
    expect(byTarget["doc-1"]).toBe("normal");
  });

  it("Q5: an expense at or above the currency threshold is high_risk; one below it is normal", async () => {
    db.rows("expenses").push({ id: "exp-big", workspace_id: WS, project_id: "proj-1", description: "Plant", amount: 50_000 });
    db.rows("expenses").push({ id: "exp-neg", workspace_id: WS, project_id: "proj-1", description: "Refund", amount: -75_000 });
    await call(deleteExpense, session(ALICE, "admin"), "exp-1", { reason: "x" });
    await call(deleteExpense, session(ALICE, "admin"), "exp-big", { reason: "x" });
    await call(deleteExpense, session(ALICE, "admin"), "exp-neg", { reason: "x" });
    const byTarget = Object.fromEntries(db.rows("deletion_requests").map((r) => [r.target_id as string, r.tier]));
    expect(byTarget["exp-1"]).toBe("normal");
    expect(byTarget["exp-big"]).toBe("high_risk");
    expect(byTarget["exp-neg"]).toBe("high_risk");
  });

  it("Q5: the workspace's own threshold is used", async () => {
    db.rows("workspaces").push({ id: WS, approval_policy: { currency_threshold: 400 } });
    await call(deleteExpense, session(ALICE, "admin"), "exp-1", { reason: "x" });
    expect(db.rows("deletion_requests")[0].tier).toBe("high_risk");
  });

  it("Q5: a high-risk expense deletion is approved by an admin; a manager is refused once a second admin exists", async () => {
    db.rows("expenses").push({ id: "exp-big", workspace_id: WS, project_id: "proj-1", description: "Plant", amount: 90_000 });
    db.rows("profiles").push({ id: "adm-2", workspace_id: WS, role: "admin" });
    const id = (await (await call(deleteExpense, session(CARA, "manager"), "exp-big", { reason: "x" })).json()).data.id as string;
    const refused = await call(approve, session(BOB, "manager"), id, {}, "POST");
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("role_not_permitted");
    expect(db.rows("expenses").some((x) => x.id === "exp-big")).toBe(true);
    const ok = await call(approve, session(ALICE, "admin"), id, {}, "POST");
    expect(ok.status).toBe(200);
    expect(db.rows("expenses").some((x) => x.id === "exp-big")).toBe(false);
  });

  it("Q4: a manager approves the deletion of an approved document (no admin gate in the commit)", async () => {
    db.rows("deletion_requests").push({
      id: "del-doc2", workspace_id: WS, target_type: "document", target_id: "doc-ok", status: "pending", reason: "x", tier: "normal",
      requested_by_type: "user", requested_by_id: ALICE, requested_by_label: "Alice", requested_principal_id: ALICE,
      before: { id: "doc-ok", title: "Signed charter", project_id: "proj-1" },
    });
    const res = await call(approve, session(BOB, "manager"), "del-doc2", {}, "POST");
    expect(res.status).toBe(200);
    expect(db.rows("documents").some((d) => d.id === "doc-ok")).toBe(false);
  });

  it.each(ENTITIES)("$entity: the reason is required (422), nothing is created", async (e) => {
    for (const body of [undefined, {}, { reason: "  " }]) {
      const res = await call(e.handler, session(ALICE), e.id, body);
      expect(res.status).toBe(422);
    }
    expect(db.rows("deletion_requests")).toHaveLength(0);
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it.each(ENTITIES)("$entity: a second pending request for the same record is a 422 duplicate", async (e) => {
    expect((await call(e.handler, session(ALICE), e.id, { reason: "x" })).status).toBe(202);
    const again = await call(e.handler, session(ALICE), e.id, { reason: "y" });
    expect(again.status).toBe(422);
    expect((await again.json()).code).toBe("duplicate_deletion_request");
    expect(db.rows("deletion_requests")).toHaveLength(1);
  });

  it.each(ENTITIES)("$entity: unknown id is a 404", async (e) => {
    const res = await call(e.handler, session(ALICE), "nope", { reason: "x" });
    expect(res.status).toBe(404);
  });

  it("a record of another workspace is a 404, not a request", async () => {
    db.rows("risks").push({ id: "risk-other", workspace_id: "ws-2", project_id: "p", title: "Theirs" });
    expect((await call(deleteRisk, session(ALICE), "risk-other", { reason: "x" })).status).toBe(404);
  });

  it("a viewer cannot raise one (403) and a token without an owner cannot either", async () => {
    expect((await call(deleteRisk, session(CARA, "viewer"), "risk-1", { reason: "x" })).status).toBe(403);
    const orphan = await call(deleteRisk, pat("tok-o", null, REQUEST_SCOPES), "risk-1", { reason: "x" });
    expect(orphan.status).toBe(403);
    expect((await orphan.json()).code).toBe("no_principal");
    expect(db.rows("deletion_requests")).toHaveLength(0);
  });
});

describe("scopes: <entity>:delete:request, with the wave-1 risk:delete / issue:delete meaning 'request'", () => {
  it.each(ENTITIES)("$entity: a token needs $entity:delete:request", async (e) => {
    const without = pat("tok-w", BOB, [`${e.entity}:write`, "budget:write", "document:write", "milestone:write"]);
    const res = await call(e.handler, without, e.id, { reason: "x" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain(`${e.entity}:delete:request`);
    const ok = await call(e.handler, pat("tok-r", BOB, [`${e.entity}:delete:request`]), e.id, { reason: "x" });
    expect(ok.status).toBe(202);
  });

  it("the old risk:delete and issue:delete scopes still work and now only request (202, not 204)", async () => {
    const r = await call(deleteRisk, pat("tok-old", BOB, ["risk:delete"]), "risk-1", { reason: "old token" });
    expect(r.status).toBe(202);
    const i = await call(deleteIssue, pat("tok-old2", BOB, ["issue:delete"]), "issue-1", { reason: "old token" });
    expect(i.status).toBe(202);
    expect(db.rows("risks")).toHaveLength(1);
    expect(db.rows("issues")).toHaveLength(1);
  });

  it("a <resource>:* wildcard grants the request scope but never the approve scope", async () => {
    const wild = pat("tok-wild", BOB, ["risk:*"]);
    expect((await call(deleteRisk, wild, "risk-1", { reason: "x" })).status).toBe(202);
    const id = db.rows("deletion_requests")[0].id as string;
    expect((await call(approve, { ...wild, principalId: ALICE }, id, {}, "POST")).status).toBe(403);
  });

  it("the agent preset holds no deletion scope of any kind", () => {
    for (const s of AGENT_PRESET_SCOPES) expect(s).not.toMatch(/:delete/);
  });
});

describe("milestones", () => {
  it("records how many tasks the delete detaches, for the approver", async () => {
    await call(deleteMilestone, session(ALICE), "ms-1", { reason: "obsolete" });
    expect(db.rows("deletion_requests")[0].before).toMatchObject({ child_counts: { tasks: 2 } });
  });

  it("is refused while the project is locked: 422, audited as blocked, no request", async () => {
    const res = await call(deleteMilestone, session(ALICE), "ms-locked", { reason: "x" });
    expect(res.status).toBe(422);
    expect(db.rows("deletion_requests")).toHaveLength(0);
    expect(auditActions()).toEqual(["milestone.delete_request.blocked"]);
  });

  it("approval is refused when the task count moved since the request (children_changed)", async () => {
    await call(deleteMilestone, session(ALICE), "ms-1", { reason: "obsolete" });
    const id = db.rows("deletion_requests")[0].id as string;
    db.rows("tasks").push({ id: "t3", workspace_id: WS, project_id: "proj-1", milestone_id: "ms-1", name: "C" });
    const res = await call(approve, session(BOB, "manager"), id, {}, "POST");
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("children_changed");
    expect(db.rows("milestones").some((m) => m.id === "ms-1")).toBe(true);
  });

  it("approval detaches the tasks and removes the milestone", async () => {
    await call(deleteMilestone, session(ALICE), "ms-1", { reason: "obsolete" });
    const id = db.rows("deletion_requests")[0].id as string;
    expect((await call(approve, session(BOB, "manager"), id, {}, "POST")).status).toBe(200);
    expect(db.rows("milestones").some((m) => m.id === "ms-1")).toBe(false);
    expect(db.rows("tasks").every((t) => t.milestone_id === null)).toBe(true);
  });

  it("a project locked after the request closes it instead of leaving it failing", async () => {
    await call(deleteMilestone, session(ALICE), "ms-1", { reason: "obsolete" });
    const id = db.rows("deletion_requests")[0].id as string;
    db.rows("projects")[0].is_locked = true;
    const res = await call(approve, session(BOB, "manager"), id, {}, "POST");
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("project_locked");
    expect(db.rows("deletion_requests")[0].status).toBe("withdrawn");
  });
});

describe("approved documents (owner decision Q4): manager tier, tracked, no admin gate", () => {
  it("a manager can request deletion of an approved document: 202, a normal-tier request, audited", async () => {
    const res = await call(deleteDocument, session(BOB, "manager"), "doc-ok", { reason: "x" });
    expect(res.status).toBe(202);
    expect(db.rows("deletion_requests")).toHaveLength(1);
    expect(db.rows("deletion_requests")[0].tier).toBe("normal");
    expect(auditActions()).toEqual(["document.delete_requested"]);
  });

  it("an admin can too; a draft document is the same", async () => {
    expect((await call(deleteDocument, session(ALICE, "admin"), "doc-ok", { reason: "x" })).status).toBe(202);
    expect((await call(deleteDocument, session(BOB, "manager"), "doc-1", { reason: "x" })).status).toBe(202);
  });

  it("a token is judged by the human behind it, exactly as for any document", async () => {
    const adminTok = pat("tok-a", ALICE, ["document:delete:request"], "admin");
    expect((await call(deleteDocument, adminTok, "doc-ok", { reason: "x" })).status).toBe(202);
  });

  it("the refusal code approved_document_needs_admin no longer exists", async () => {
    db.rows("deletion_requests").push({
      id: "del-doc", workspace_id: WS, target_type: "document", target_id: "doc-ok", status: "pending", reason: "x", tier: "normal",
      requested_by_type: "user", requested_by_id: CARA, requested_by_label: "Cara", requested_principal_id: CARA,
      before: { id: "doc-ok", title: "Signed charter", project_id: "proj-1" },
    });
    const res = await call(approve, session(BOB, "manager"), "del-doc", {}, "POST");
    expect(res.status).toBe(200);
    expect(db.rows("documents").some((d) => d.id === "doc-ok")).toBe(false);
  });
});

describe("approve / reject / withdraw dispatch by target type", () => {
  async function raise(e: (typeof ENTITIES)[number], actor = session(ALICE)) {
    const res = await call(e.handler, actor, e.id, { reason: "duplicate" });
    expect(res.status).toBe(202);
    return (await res.json()).data.id as string;
  }

  it.each(ENTITIES)("$entity: the requester's own PAT cannot approve (403 self_approval)", async (e) => {
    const id = await raise(e);
    const res = await call(approve, alicePat(), id, {}, "POST");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("self_approval");
    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(true);
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
  });

  it.each(ENTITIES)("$entity: a manager approves; the commit RPC gets the principal; both audit rows land", async (e) => {
    const id = await raise(e);
    const res = await call(approve, bobPat(), id, { note: "agreed" }, "POST");
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    const rpc = db.rpcCalls.find((c) => c.name === `nopm_commit_${e.entity}_deletion`);
    expect(rpc?.args).toMatchObject({
      p_request_id: id,
      p_workspace_id: WS,
      p_approver_principal_id: BOB,
      p_note: "agreed",
    });
    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(false);
    expect(auditActions()).toEqual([`${e.entity}.delete_requested`, `${e.entity}.delete`, "deletion_request.approved"]);
    await flush();
    expect(emitted.decided[0]).toMatchObject({ kind: `${e.entity}_deletion`, status: "committed" });
  });

  it.each(ENTITIES)("$entity: approving needs $entity:delete:approve (a task approve scope is not enough)", async (e) => {
    const id = await raise(e);
    const wrong = pat("tok-wrong", BOB, ["task:delete:approve", "project:delete:approve"]);
    const res = await call(approve, wrong, id, {}, "POST");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain(`${e.entity}:delete:approve`);
    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(true);
  });

  it("a manager cannot approve a high_risk (admin-tier) request; with fewer than two admins the fallback allows it", async () => {
    const id = await raise(ENTITIES[0]);
    db.rows("deletion_requests")[0].tier = "high_risk";
    db.rows("profiles").push({ id: "99999999-9999-4999-8999-999999999999", workspace_id: WS, role: "admin" });
    const res = await call(approve, bobPat(), id, {}, "POST");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("role_not_permitted");
    expect(db.rows("risks").some((r) => r.id === "risk-1")).toBe(true);
    db.tables.profiles = db.rows("profiles").filter((p) => p.id !== "99999999-9999-4999-8999-999999999999");
    expect((await call(approve, bobPat(), id, {}, "POST")).status).toBe(200);
  });

  it("a member (not manager or admin) cannot approve even holding the scope", async () => {
    const id = await raise(ENTITIES[0]);
    const memberTok = pat("tok-m", CARA, APPROVE_SCOPES, "member");
    const res = await call(approve, memberTok, id, {}, "POST");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("role_not_permitted");
  });

  it.each(ENTITIES)("$entity: reject leaves the record in place", async (e) => {
    const id = await raise(e);
    const res = await call(reject, bobPat(), id, { reason: "still needed" }, "POST");
    expect(res.status).toBe(200);
    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(true);
    expect(db.rows("deletion_requests")[0].status).toBe("rejected");
  });

  it.each(ENTITIES)("$entity: the requester withdraws their own request; nobody else does", async (e) => {
    const id = await raise(e);
    const other = await call(withdraw, session(BOB, "manager"), id, undefined, "POST");
    expect(other.status).toBe(403);
    const own = await call(withdraw, session(ALICE), id, undefined, "POST");
    expect(own.status).toBe(200);
    expect(db.rows("deletion_requests")[0].status).toBe("withdrawn");
    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(true);
  });

  it("the old wave-1 scope can withdraw the request it raised", async () => {
    const tok = pat("tok-old", ALICE, ["risk:delete"], "admin");
    const raised = await call(deleteRisk, tok, "risk-1", { reason: "old token" });
    const id = (await raised.json()).data.id as string;
    expect((await call(withdraw, tok, id, undefined, "POST")).status).toBe(200);
  });

  it("a request whose record is already gone is closed, not committed (target_gone)", async () => {
    const id = await raise(ENTITIES[0]);
    db.tables.risks = [];
    const res = await call(approve, bobPat(), id, {}, "POST");
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("target_gone");
    expect(db.rows("deletion_requests")[0].status).toBe("withdrawn");
    expect(auditActions()).not.toContain("risk.delete");
  });
});
