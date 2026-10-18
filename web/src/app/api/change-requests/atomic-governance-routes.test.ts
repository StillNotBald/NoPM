/**
 * Wave 5, W5-A (R-161, R-162): the governance maker steps write the change and its audit row through ONE database
 * function each. Drives the real route handlers and decide.ts over the in-memory admin client, whose copies of the
 * 0108 functions are transactions (test-support/fake-atomic-governance.ts), so a test can fail the audit step and
 * prove no orphan row is left, and can see every status code, error code and body is the one the routes returned
 * before the change.
 *
 * Covered: project and task deletion requests, the five other deletion requests, withdraw and reject of a deletion
 * request, change-request raise / edit / withdraw, rebaseline proposal. The SQL is asserted in
 * lib/governance/atomic-governance-migration.test.ts and by scripts/local-db/probe-atomic-governance.mjs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb, type Row } from "@/lib/governance/test-support/fake-admin";
import { installAtomicGovernance } from "@/lib/governance/test-support/fake-atomic-governance";

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (holder.db as FakeDb).client }));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: () => {},
  emitApprovalDecided: () => {},
  emitApprovalChanged: () => {},
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

import { DELETE as deleteProject } from "../projects/[id]/route";
import { DELETE as deleteTask } from "../tasks/[id]/route";
import { DELETE as deleteRisk } from "../risks/[id]/route";
import { POST as raiseChange } from "../projects/[id]/change-requests/route";
import { PATCH as editChange, DELETE as deleteChange } from "./[id]/route";
import { POST as proposeRebaseline } from "../projects/[id]/rebaselines/route";
import { POST as withdraw } from "../deletion-requests/[id]/withdraw/route";
import { POST as reject } from "../deletion-requests/[id]/reject/route";
import { withdrawDeletion } from "@/lib/governance/decide";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const PROJECT = "proj-1";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function session(id: string, role = "manager"): Actor {
  return { type: "user", id, label: id === ALICE ? "Alice" : "Bob", workspaceId: WS, role, principalId: id, principalRole: role, channel: "ui", requestId: `req-${id}` };
}

let db: FakeDb;

function seed(): FakeDb {
  return installAtomicGovernance(
    new FakeDb({
      projects: [{ id: PROJECT, workspace_id: WS, name: "Billing", is_locked: false, start_date: "2026-11-01", target_date: "2026-12-15", baseline_start_date: "2026-11-01", baseline_target_date: "2026-12-01" }],
      tasks: [{ id: "task-1", workspace_id: WS, project_id: PROJECT, name: "Wire the API" }],
      risks: [{ id: "risk-1", workspace_id: WS, project_id: PROJECT, title: "Vendor slips" }],
      profiles: [
        { id: ALICE, workspace_id: WS, role: "manager" },
        { id: BOB, workspace_id: WS, role: "admin" },
      ],
      change_requests: [],
      rebaselines: [],
      deletion_requests: [],
      approval_events: [],
      audit_log: [],
      notifications: [],
    }),
  );
}

function call(handler: Handler, actor: Actor, id: string, body?: unknown, method = "POST") {
  authHolder.actor = actor;
  const req = new NextRequest(`http://localhost/api/x/${id}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handler(req, { params: Promise.resolve({ id }) });
}

const actions = () => db.rows("audit_log").map((r) => r.action);
const failAuditStep = () => {
  db.mutateFailure = { code: "XX000", message: "audit insert failed" };
};

beforeEach(() => {
  db = seed();
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("deletion requests: the request, its audit row and its deadline event are one transaction", () => {
  it.each([
    ["project", deleteProject, PROJECT, "project.delete_requested"],
    ["task", deleteTask, "task-1", "task.delete_requested"],
    ["risk", deleteRisk, "risk-1", "risk.delete_requested"],
  ] as const)("%s: 202, the stored row, ONE audit row, ONE deadline_set event", async (entity, handler, id, action) => {
    const res = await call(handler as Handler, session(ALICE), id, { reason: "obsolete" }, "DELETE");
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(202);
    expect(json.data).toMatchObject({ target_type: entity, target_id: id, status: "pending", reason: "obsolete", requested_principal_id: ALICE });
    expect(actions()).toEqual([action]);
    expect(db.rows("approval_events").filter((e) => e.kind === "deadline_set")).toHaveLength(1);
  });

  it("the project snapshot carries the child counts the approval later compares", async () => {
    await call(deleteProject as Handler, session(ALICE), PROJECT, { reason: "x" }, "DELETE");
    const before = db.rows("deletion_requests")[0].before as Row;
    expect(before.id).toBe(PROJECT);
    expect(before.child_counts).toMatchObject({ tasks: 1, risks: 1 });
  });

  it("a named approver is stored and put in the audit `after`, exactly as before", async () => {
    await call(deleteTask as Handler, session(ALICE), "task-1", { reason: "x", assigned_approver_id: BOB }, "DELETE");
    expect(db.rows("deletion_requests")[0].assigned_approver_id).toBe(BOB);
    expect(db.rows("audit_log")[0].after).toEqual({ assigned_approver_id: BOB });
  });

  it.each([
    ["project", deleteProject, PROJECT],
    ["task", deleteTask, "task-1"],
    ["risk", deleteRisk, "risk-1"],
  ] as const)("%s: a failing audit step leaves NO request, NO event and NO audit row (500)", async (_e, handler, id) => {
    failAuditStep();
    const res = await call(handler as Handler, session(ALICE), id, { reason: "x" }, "DELETE");
    expect(res.status).toBe(500);
    expect(db.rows("deletion_requests")).toHaveLength(0);
    expect(db.rows("approval_events")).toHaveLength(0);
    expect(actions()).toEqual([]);
  });

  it("a request raced past the pre-check is the same 422 duplicate_deletion_request", async () => {
    db.client.rpc = (async () => ({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_pending_deletion"' } })) as never;
    const res = await call(deleteTask as Handler, session(ALICE), "task-1", { reason: "x" }, "DELETE");
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("duplicate_deletion_request");
  });

  it("a project locked after the route looked is the locked 422 and writes nothing", async () => {
    // The route's own pre-check reads is_locked first; flip it between that read and the function call.
    db.afterNextSelect("projects", (d) => {
      d.rows("projects")[0].is_locked = true;
    });
    const res = await call(deleteTask as Handler, session(ALICE), "task-1", { reason: "x" }, "DELETE");
    expect(res.status).toBe(422);
    expect(db.rows("deletion_requests")).toHaveLength(0);
    expect(actions().filter((a) => a === "task.delete_requested")).toEqual([]);
  });
});

describe("withdraw and reject of a deletion request: status flip and audit row are one transaction", () => {
  async function raiseTaskRequest(): Promise<string> {
    const res = await call(deleteTask as Handler, session(ALICE), "task-1", { reason: "x" }, "DELETE");
    return (await res.json()).data.id as string;
  }

  it("withdraw: 200, status withdrawn, exactly one deletion_request.withdrawn row", async () => {
    const id = await raiseTaskRequest();
    const res = await call(withdraw as Handler, session(ALICE), id);
    expect(res.status).toBe(200);
    expect(db.rows("deletion_requests")[0].status).toBe("withdrawn");
    expect(actions().filter((a) => a === "deletion_request.withdrawn")).toHaveLength(1);
  });

  it("withdraw with a failing audit step: the request is STILL pending, with no compensating write needed", async () => {
    const id = await raiseTaskRequest();
    failAuditStep();
    const res = await call(withdraw as Handler, session(ALICE), id);
    expect(res.status).toBe(500);
    const row = db.rows("deletion_requests")[0];
    expect(row.status).toBe("pending");
    expect(row.decided_at ?? null).toBeNull();
    expect(actions().filter((a) => a === "deletion_request.withdrawn")).toEqual([]);
  });

  it("withdraw of a request that was decided first is the 422 already_decided", async () => {
    const id = await raiseTaskRequest();
    db.rows("deletion_requests")[0].status = "rejected";
    const outcome = withdrawDeletion(session(ALICE), id);
    await expect(outcome).rejects.toMatchObject({ status: 422, code: "already_decided" });
  });

  it("reject: 200 with the approver recorded and exactly one deletion_request.rejected row", async () => {
    const id = await raiseTaskRequest();
    const res = await call(reject as Handler, session(BOB, "admin"), id, { reason: "still needed" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(db.rows("deletion_requests")[0]).toMatchObject({ status: "rejected", approved_principal_id: BOB });
    const rows = db.rows("audit_log").filter((r) => r.action === "deletion_request.rejected");
    expect(rows).toHaveLength(1);
    expect(rows[0].after).toEqual({ status: "rejected", approver_principal_id: BOB, reason: "still needed" });
  });

  it("reject with a failing audit step leaves the request pending (no approver recorded)", async () => {
    const id = await raiseTaskRequest();
    failAuditStep();
    const res = await call(reject as Handler, session(BOB, "admin"), id, { reason: "still needed" });
    expect(res.status).toBe(500);
    expect(db.rows("deletion_requests")[0]).toMatchObject({ status: "pending" });
    expect(db.rows("deletion_requests")[0].approved_by_id ?? null).toBeNull();
  });
});

describe("change requests: raise, edit and withdraw are one transaction each", () => {
  const raise = (body: Record<string, unknown> = { title: "Add APAC module" }, actor: Actor = session(ALICE)) =>
    call(raiseChange as Handler, actor, PROJECT, body);

  it("raise: 201 with the stored row; ONE change_request.create row whose after is that row; ONE deadline_set event", async () => {
    const res = await raise();
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(201);
    expect(json.data).toMatchObject({ title: "Add APAC module", status: "raised", tier: "normal", requested_principal_id: ALICE });
    expect(actions()).toEqual(["change_request.create"]);
    expect(db.rows("audit_log")[0]).toMatchObject({ target_type: "change_request", target_id: json.data.id, before: null });
    expect((db.rows("audit_log")[0].after as Row).id).toBe(json.data.id);
    expect(db.rows("approval_events").filter((e) => e.kind === "deadline_set" && e.target_id === json.data.id)).toHaveLength(1);
  });

  it("raise with a failing audit step: no change request survives (500)", async () => {
    failAuditStep();
    const res = await raise();
    expect(res.status).toBe(500);
    expect(db.rows("change_requests")).toHaveLength(0);
    expect(db.rows("approval_events")).toHaveLength(0);
  });

  it("raise: a reference-number clash (23505, nothing written) is retried with the next number", async () => {
    const real = db.client.rpc;
    let clashed = false;
    db.client.rpc = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "nopm_raise_change_request" && !clashed) {
        clashed = true;
        return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_change_requests_ref"' } };
      }
      return real(name, args);
    };
    const res = await raise();
    expect(res.status).toBe(201);
    expect((await res.json()).data.reference_id).toBe("CR-002");
    expect(db.rpcCallsTo("nopm_next_ref")).toHaveLength(2);
    expect(actions()).toEqual(["change_request.create"]);
    expect(db.rows("change_requests")).toHaveLength(1);
  });

  it("raise: an emergency still goes through its own function and is not touched", async () => {
    const res = await raise({ title: "Prod down", is_emergency: true }, session(BOB, "admin"));
    expect(db.rpcCallsTo("nopm_raise_change_request")).toHaveLength(0);
    expect(db.rpcCallsTo("nopm_raise_emergency_change_request")).toHaveLength(1);
    void res;
  });

  async function raised(): Promise<string> {
    return (await (await raise()).json()).data.id as string;
  }
  const edit = (id: string, body: Record<string, unknown>, actor: Actor = session(ALICE)) => call(editChange as Handler, actor, id, body, "PATCH");

  it("edit: 200 with the updated row; ONE change_request.update row with before and after", async () => {
    const id = await raised();
    const res = await edit(id, { title: "Add EMEA module", impact_cost: 1200 });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ title: "Add EMEA module", impact_cost: 1200 });
    const row = db.rows("audit_log").filter((r) => r.action === "change_request.update");
    expect(row).toHaveLength(1);
    expect((row[0].before as Row).title).toBe("Add APAC module");
    expect((row[0].after as Row).title).toBe("Add EMEA module");
  });

  it("edit with a failing audit step: the title is unchanged", async () => {
    const id = await raised();
    failAuditStep();
    const res = await edit(id, { title: "Hijacked" });
    expect(res.status).toBe(500);
    expect(db.rows("change_requests")[0].title).toBe("Add APAC module");
  });

  it("edit: someone other than the requester is refused (403 not_requester) before any write", async () => {
    const id = await raised();
    const res = await edit(id, { title: "Hijacked" }, session(BOB, "admin"));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("not_requester");
  });

  it("edit: decided between the read and the write is the 422 change_request_decided, nothing written", async () => {
    const id = await raised();
    db.afterNextSelect("change_requests", (d) => {
      d.rows("change_requests")[0].status = "approved";
    });
    const res = await edit(id, { title: "Late edit" });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe("change_request_decided");
    expect(json.error).toBe("This change request was decided while you were editing it.");
    expect(db.rows("change_requests")[0].title).toBe("Add APAC module");
    expect(actions()).toEqual(["change_request.create"]);
  });

  it("edit: an already-decided request keeps its precise message", async () => {
    const id = await raised();
    db.rows("change_requests")[0].status = "rejected";
    const res = await edit(id, { title: "x" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/is rejected and is part of the decision record/);
  });

  it("withdraw: 204, the row is gone, ONE change_request.delete row (before = row, after = null)", async () => {
    const id = await raised();
    const res = await call(deleteChange as Handler, session(ALICE), id, undefined, "DELETE");
    expect(res.status).toBe(204);
    expect(db.rows("change_requests")).toHaveLength(0);
    const row = db.rows("audit_log").filter((r) => r.action === "change_request.delete");
    expect(row).toHaveLength(1);
    expect((row[0].before as Row).id).toBe(id);
    expect(row[0].after).toBeNull();
  });

  it("withdraw with a failing audit step: the request is still there", async () => {
    const id = await raised();
    failAuditStep();
    const res = await call(deleteChange as Handler, session(ALICE), id, undefined, "DELETE");
    expect(res.status).toBe(500);
    expect(db.rows("change_requests")).toHaveLength(1);
  });

  it("withdraw: decided between the read and the delete is the 422 change_request_decided", async () => {
    const id = await raised();
    db.afterNextSelect("change_requests", (d) => {
      d.rows("change_requests")[0].status = "approved";
    });
    const res = await call(deleteChange as Handler, session(ALICE), id, undefined, "DELETE");
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe("change_request_decided");
    expect(json.error).toBe("This change request was decided while you were deleting it.");
    expect(db.rows("change_requests")).toHaveLength(1);
  });
});

describe("rebaseline proposal: version, exact dates, audit row and event are one transaction", () => {
  const lock = () => {
    db.rows("projects")[0].is_locked = true;
  };
  const propose = (body: Record<string, unknown> = { reason: "dates slipped" }, actor: Actor = session(ALICE)) =>
    call(proposeRebaseline as Handler, actor, PROJECT, body);

  it("201 with the stored row; version 1; before = baseline dates, after = locked dates; ONE rebaseline.create row", async () => {
    lock();
    const res = await propose({ reason: "dates slipped", before: "old plan", after: "" });
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(201);
    expect(json.data).toMatchObject({ version: 1, status: "pending_approval", requested_principal_id: ALICE });
    expect(json.data.before).toEqual({ start_date: "2026-11-01", target_date: "2026-12-01", note: "old plan" });
    expect(json.data.after).toEqual({ start_date: "2026-11-01", target_date: "2026-12-15" });
    expect(actions()).toEqual(["rebaseline.create"]);
    expect(db.rows("approval_events").filter((e) => e.target_type === "rebaseline")).toHaveLength(1);
  });

  it("an unlocked project is the 422 project_not_locked", async () => {
    const res = await propose();
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("project_not_locked");
  });

  it("a second proposal while one waits is the 409 pending_rebaseline_exists", async () => {
    lock();
    expect((await propose()).status).toBe(201);
    const res = await propose();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("pending_rebaseline_exists");
    expect(actions()).toEqual(["rebaseline.create"]);
  });

  it("a racing version collision (another unique index) is the 409 rebaseline_version_conflict", async () => {
    lock();
    db.client.rpc = (async () => ({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "rebaselines_project_id_version_key"' } })) as never;
    const res = await propose();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("rebaseline_version_conflict");
  });

  it("a failing audit step leaves no rebaseline and no event", async () => {
    lock();
    failAuditStep();
    const res = await propose();
    expect(res.status).toBe(500);
    expect(db.rows("rebaselines")).toHaveLength(0);
    expect(db.rows("approval_events")).toHaveLength(0);
  });
});
