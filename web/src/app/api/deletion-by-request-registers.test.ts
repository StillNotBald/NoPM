/**
 * R-176 / R-177 (wave 5, W5-G, migrations 0113 and 0114): deletion is a REQUEST for programs, sprints, resources
 * (resource_members), allocations and clashes. The five DELETE routes used to answer 204 and delete; they now answer
 * 202 with the deletion_requests row, the same body the other seven kinds return (decision D19).
 *
 * Drives the real route handlers with an in-memory admin client (requireAuth mocked, requireScope real):
 *   - the 202 contract, the stored tier (program high_risk, the others normal, D15), the snapshot and child counts;
 *   - the rules the direct deletes had (planned sprint without tasks, member without archived timesheets);
 *   - four-eyes (a requester cannot approve their own request), the tier role, a stale request failing 422;
 *   - approval removes the record (and a resource's allocations); no chat card is sent for these kinds (D17).
 *
 * The SQL itself (commit RPCs, entity map, triggers) is asserted in lib/governance/deletion-registers-migration.test.ts
 * and run for real by scripts/local-db/probe-deletion-registers.mjs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";
import { installAtomicGovernance } from "@/lib/governance/test-support/fake-atomic-governance";
import { AGENT_PRESET_SCOPES } from "@/lib/auth/scopes";

const { holder, emitted, authHolder, detect } = vi.hoisted(() => ({
  detect: vi.fn(async (...args: unknown[]) => ({ detected: args.length < 0, warning: null as string | null })),
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
vi.mock("@/lib/clash/detect", () => ({ detectOverAllocationSafe: detect }));
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

import { DELETE as deleteProgram } from "./programs/[id]/route";
import { DELETE as deleteSprint } from "./sprints/[id]/route";
import { DELETE as deleteResource } from "./resources/[id]/route";
import { DELETE as deleteAllocation } from "./allocations/[id]/route";
import { DELETE as deleteClash } from "./clashes/[id]/route";
import { POST as approve } from "./deletion-requests/[id]/approve/route";
import { POST as reject } from "./deletion-requests/[id]/reject/route";
import { POST as withdraw } from "./deletion-requests/[id]/withdraw/route";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111"; // admin
const BOB = "22222222-2222-4222-8222-222222222222"; // manager
const CARA = "33333333-3333-4333-8333-333333333333"; // member
const ERIN = "44444444-4444-4444-8444-444444444444"; // second admin

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const ENTITIES = [
  { entity: "program", table: "programs", handler: deleteProgram, id: "prog-1", tier: "high_risk", write: "program:write" },
  { entity: "sprint", table: "sprints", handler: deleteSprint, id: "spr-1", tier: "normal", write: "sprint:write" },
  { entity: "resource", table: "resource_members", handler: deleteResource, id: "res-1", tier: "normal", write: "resource:write" },
  { entity: "allocation", table: "allocations", handler: deleteAllocation, id: "al-1", tier: "normal", write: "resource:write" },
  { entity: "clash", table: "clashes", handler: deleteClash, id: "clash-1", tier: "normal", write: "clash:write" },
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

let db: FakeDb;

function seed(): FakeDb {
  return new FakeDb({
    projects: [
      { id: "proj-1", workspace_id: WS, name: "Billing Migration", is_locked: false },
      { id: "proj-locked", workspace_id: WS, name: "Frozen", is_locked: true },
      { id: "proj-in-prog", workspace_id: WS, name: "Child", is_locked: false, program_id: "prog-1" },
    ],
    programs: [{ id: "prog-1", workspace_id: WS, name: "Payments" }],
    sprints: [
      { id: "spr-1", workspace_id: WS, project_id: "proj-1", name: "Sprint 1", state: "planned" },
      { id: "spr-active", workspace_id: WS, project_id: "proj-1", name: "Sprint 2", state: "active" },
      { id: "spr-tasks", workspace_id: WS, project_id: "proj-1", name: "Sprint 3", state: "planned" },
      { id: "spr-locked", workspace_id: WS, project_id: "proj-locked", name: "Frozen sprint", state: "planned" },
    ],
    tasks: [{ id: "t-in-sprint", workspace_id: WS, project_id: "proj-1", sprint_id: "spr-tasks", name: "A" }],
    resource_members: [
      { id: "res-1", workspace_id: WS, name: "Dana" },
      { id: "res-sheet", workspace_id: WS, name: "Eli" },
    ],
    allocations: [
      { id: "al-1", workspace_id: WS, member_id: "res-1", project_id: "proj-1", allocation_pct: 50 },
      { id: "al-2", workspace_id: WS, member_id: "res-1", project_id: "proj-1", allocation_pct: 25 },
    ],
    timesheet_submissions: [{ id: "ts-1", workspace_id: WS, member_id: "res-sheet", status: "approved" }],
    clashes: [{ id: "clash-1", workspace_id: WS, title: "Overlap on Apollo", project_a_id: "proj-1" }],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "admin" },
      { id: ERIN, workspace_id: WS, role: "admin" },
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

beforeEach(() => {
  db = installAtomicGovernance(seed());
  holder.db = db;
  emitted.requested.length = 0;
  emitted.decided.length = 0;
  detect.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("DELETE is the maker step: 202 with the request row, never a delete (D19)", () => {
  it.each(ENTITIES)("$entity: answers 202 { data: <deletion_requests row> }, audits $entity.delete_requested, keeps the record", async (e) => {
    const res = await call(e.handler, session(ALICE), e.id, { reason: "not needed" });
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(202);
    expect(json.data).toMatchObject({ target_type: e.entity, target_id: e.id, status: "pending", reason: "not needed", tier: e.tier });
    expect(typeof json.data.id).toBe("string");

    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(true);
    const req = db.rows("deletion_requests");
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ target_type: e.entity, requested_by_id: ALICE, requested_principal_id: ALICE, before: expect.objectContaining({ id: e.id }) });
    expect(auditActions()).toEqual([`${e.entity}.delete_requested`]);
  });

  it.each(ENTITIES)("$entity: the tier is fixed by the kind (program high_risk, the others normal), with a decision deadline", async (e) => {
    expect((await call(e.handler, session(ALICE), e.id, { reason: "x" })).status).toBe(202);
    const req = db.rows("deletion_requests")[0];
    expect(req.tier).toBe(e.tier);
    expect(typeof req.approval_deadline_at).toBe("string");
    expect(db.rows("approval_events").some((x) => x.kind === "deadline_set" && x.target_id === req.id)).toBe(true);
  });

  it("a requester cannot ask for LESS than the kind's tier: the program request is high_risk whatever the policy says", async () => {
    db.rows("workspaces").push({ id: WS, approval_policy: { tiers: { normal: { approver_role: "manager", turnaround_hours: 24 } } } });
    await call(deleteProgram, session(BOB, "manager"), "prog-1", { reason: "x" });
    expect(db.rows("deletion_requests")[0].tier).toBe("high_risk");
  });

  it.each(ENTITIES)("$entity: no chat card is announced (D17: lib/integrations/types is untouched)", async (e) => {
    await call(e.handler, session(ALICE), e.id, { reason: "x" });
    expect(emitted.requested).toHaveLength(0);
  });

  it.each(ENTITIES)("$entity: the reason is required (422), nothing is created", async (e) => {
    for (const body of [undefined, {}, { reason: "  " }]) {
      expect((await call(e.handler, session(ALICE), e.id, body)).status).toBe(422);
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

  it.each(ENTITIES)("$entity: an unknown id is a 404", async (e) => {
    expect((await call(e.handler, session(ALICE), "nope", { reason: "x" })).status).toBe(404);
  });

  it("a record of another workspace is a 404, not a request", async () => {
    db.rows("clashes").push({ id: "clash-other", workspace_id: "ws-2", title: "Theirs" });
    expect((await call(deleteClash, session(ALICE), "clash-other", { reason: "x" })).status).toBe(404);
    expect(db.rows("deletion_requests")).toHaveLength(0);
  });

  it.each(ENTITIES)("D4: a member session may ask for a $entity deletion (it could delete before wave 5; approval stays with a manager or admin)", async (e) => {
    const res = await call(e.handler, session(CARA, "member"), e.id, { reason: "x" });
    expect(res.status).toBe(202);
    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(true);
  });

  it.each(ENTITIES)("D4: a viewer session is refused (403) for $entity and nothing is created", async (e) => {
    expect((await call(e.handler, session(CARA, "viewer"), e.id, { reason: "x" })).status).toBe(403);
    expect(db.rows("deletion_requests")).toHaveLength(0);
  });

  it.each(ENTITIES)("D4: a member cannot approve the $entity request a manager raised (403 role_not_permitted)", async (e) => {
    const id = (await (await call(e.handler, session(BOB, "manager"), e.id, { reason: "x" })).json()).data.id as string;
    const res = await call(approve, session(CARA, "member"), id, {}, "POST");
    expect(res.status).toBe(403);
    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(true);
  });

  it("a viewer cannot raise one (403); a token with no recorded owner cannot either (403 no_principal)", async () => {
    expect((await call(deleteSprint, session(CARA, "viewer"), "spr-1", { reason: "x" })).status).toBe(403);
    const orphan = await call(deleteSprint, pat("tok-o", null, ["sprint:delete:request"]), "spr-1", { reason: "x" });
    expect(orphan.status).toBe(403);
    expect((await orphan.json()).code).toBe("no_principal");
    expect(db.rows("deletion_requests")).toHaveLength(0);
  });
});

describe("scopes: <entity>:delete:request, with the old write scope still meaning 'may ask'", () => {
  it.each(ENTITIES)("$entity: a token needs $entity:delete:request or $write", async (e) => {
    const without = pat("tok-w", BOB, [`${e.entity}:read`, "task:write", "project:write"]);
    const res = await call(e.handler, without, e.id, { reason: "x" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain(`${e.entity}:delete:request`);
    expect((await call(e.handler, pat("tok-r", BOB, [`${e.entity}:delete:request`]), e.id, { reason: "x" })).status).toBe(202);
  });

  it.each(ENTITIES)("$entity: a token minted with $write before wave 5 can still ask, and the record stays", async (e) => {
    const res = await call(e.handler, pat("tok-old", BOB, [e.write]), e.id, { reason: "old token" });
    expect(res.status).toBe(202);
    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(true);
  });

  it("the agent preset holds no deletion scope of any kind", () => {
    for (const s of AGENT_PRESET_SCOPES) expect(s).not.toMatch(/:delete/);
  });

  it("a <resource>:* wildcard grants the request scope but never an approve scope", async () => {
    const wild = pat("tok-wild", BOB, ["sprint:*"]);
    expect((await call(deleteSprint, wild, "spr-1", { reason: "x" })).status).toBe(202);
    const id = db.rows("deletion_requests")[0].id as string;
    expect((await call(approve, { ...wild, principalId: ALICE }, id, {}, "POST")).status).toBe(403);
    expect(db.rows("sprints").some((s) => s.id === "spr-1")).toBe(true);
  });
});

describe("the rules the direct deletes had, now at request time", () => {
  it("sprint: only a planned sprint can be asked for (422)", async () => {
    const res = await call(deleteSprint, session(ALICE), "spr-active", { reason: "x" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/planned sprint/);
    expect(db.rows("deletion_requests")).toHaveLength(0);
  });

  it("sprint: a sprint with attached tasks is refused (422)", async () => {
    const res = await call(deleteSprint, session(ALICE), "spr-tasks", { reason: "x" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/attached tasks/);
    expect(db.rows("deletion_requests")).toHaveLength(0);
  });

  it("sprint: a sprint on a locked project can be asked for (a sprint is not schedule shape)", async () => {
    expect((await call(deleteSprint, session(ALICE), "spr-locked", { reason: "x" })).status).toBe(202);
  });

  it("resource: a member with archived timesheets is refused (422 has_timesheet_records), nothing is created", async () => {
    const res = await call(deleteResource, session(ALICE), "res-sheet", { reason: "x" });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("has_timesheet_records");
    expect(db.rows("deletion_requests")).toHaveLength(0);
    expect(auditActions()).toEqual([]);
  });

  it("resource: the request records the allocations it would delete, with their ids (PR-21)", async () => {
    await call(deleteResource, session(ALICE), "res-1", { reason: "left" });
    expect(db.rows("deletion_requests")[0].before).toMatchObject({
      child_counts: { allocations: 2, allocation_ids: ["al-1", "al-2"], assigned_tasks: 0 },
    });
  });

  it("D2: the allocation request snapshot carries a display name (resource, project, window) for the Approvals card", async () => {
    db.rows("allocations")[0].window_start = "2026-11-02";
    db.rows("allocations")[0].window_end = "2026-11-13";
    await call(deleteAllocation, session(ALICE), "al-1", { reason: "x" });
    expect(db.rows("deletion_requests")[0].before).toMatchObject({
      child_counts: { display_name: "Dana · Billing Migration · 2026-11-02 to 2026-11-13" },
    });
  });

  it("program: the request records how many projects it detaches", async () => {
    await call(deleteProgram, session(ALICE), "prog-1", { reason: "reorg" });
    expect(db.rows("deletion_requests")[0].before).toMatchObject({ child_counts: { projects: 1 } });
  });
});

describe("approval: four-eyes, the tier role, and a stale request failing 422", () => {
  const raise = async (e: (typeof ENTITIES)[number], by = session(CARA, "manager")) => {
    const res = await call(e.handler, by, e.id, { reason: "x" });
    expect(res.status).toBe(202);
    return (await res.json()).data.id as string;
  };

  it.each(ENTITIES)("$entity: the requester cannot approve their own request (403 self_approval); nothing is deleted", async (e) => {
    const id = await raise(e, session(ALICE));
    const res = await call(approve, session(ALICE), id, {}, "POST");
    expect([403, 422]).toContain(res.status);
    expect((await res.json()).code).toBe("self_approval");
    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(true);
  });

  it.each(ENTITIES.filter((e) => e.entity !== "program"))("$entity: a different manager approves it and the record is gone", async (e) => {
    const id = await raise(e);
    const res = await call(approve, session(BOB, "manager"), id, {}, "POST");
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(db.rows(e.table).some((r) => r.id === e.id)).toBe(false);
    expect(db.rows("deletion_requests")[0].status).toBe("committed");
    expect(auditActions()).toEqual([`${e.entity}.delete_requested`, `${e.entity}.delete`, "deletion_request.approved"]);
    expect(emitted.decided).toHaveLength(0);
  });

  it("program: high risk, so a manager is refused while a second admin exists; an admin approves; its projects are kept", async () => {
    const id = await raise(ENTITIES[0]);
    const refused = await call(approve, session(BOB, "manager"), id, {}, "POST");
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("role_not_permitted");
    expect(db.rows("programs").some((p) => p.id === "prog-1")).toBe(true);
    const ok = await call(approve, session(ALICE, "admin"), id, {}, "POST");
    expect(ok.status).toBe(200);
    expect(db.rows("programs").some((p) => p.id === "prog-1")).toBe(false);
    expect(db.rows("projects").some((p) => p.id === "proj-in-prog")).toBe(true);
  });

  it("resource: approving deletes the member and the allocations that hung off it", async () => {
    const id = await raise(ENTITIES[2]);
    expect((await call(approve, session(BOB, "manager"), id, {}, "POST")).status).toBe(200);
    expect(db.rows("resource_members").some((m) => m.id === "res-1")).toBe(false);
    expect(db.rows("allocations")).toHaveLength(0);
  });

  it("program: a project joining after the request makes the approval 422 children_changed", async () => {
    const id = await raise(ENTITIES[0]);
    db.rows("projects").push({ id: "late", workspace_id: WS, name: "Late", program_id: "prog-1" });
    const res = await call(approve, session(ALICE, "admin"), id, {}, "POST");
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("children_changed");
    expect(db.rows("programs").some((p) => p.id === "prog-1")).toBe(true);
  });

  it("resource: an allocation added after the request makes the approval 422 children_changed", async () => {
    const id = await raise(ENTITIES[2]);
    db.rows("allocations").push({ id: "al-3", workspace_id: WS, member_id: "res-1", allocation_pct: 5 });
    const res = await call(approve, session(BOB, "manager"), id, {}, "POST");
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("children_changed");
    expect(db.rows("resource_members").some((m) => m.id === "res-1")).toBe(true);
  });

  it("resource: a timesheet that appears after the request is refused again at approval (422 has_timesheet_records)", async () => {
    const id = await raise(ENTITIES[2]);
    db.rows("timesheet_submissions").push({ id: "ts-2", workspace_id: WS, member_id: "res-1", status: "submitted" });
    const res = await call(approve, session(BOB, "manager"), id, {}, "POST");
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("has_timesheet_records");
    expect(db.rows("resource_members").some((m) => m.id === "res-1")).toBe(true);
  });

  it("sprint: a sprint started after the request is refused at approval (422 sprint_not_planned); one that gained a task is children_changed", async () => {
    const id = await raise(ENTITIES[1]);
    db.rows("sprints").find((s) => s.id === "spr-1")!.state = "active";
    const started = await call(approve, session(BOB, "manager"), id, {}, "POST");
    expect(started.status).toBe(422);
    expect((await started.json()).code).toBe("sprint_not_planned");

    db.rows("sprints").find((s) => s.id === "spr-1")!.state = "planned";
    db.rows("tasks").push({ id: "t-late", workspace_id: WS, project_id: "proj-1", sprint_id: "spr-1", name: "Late" });
    const moved = await call(approve, session(BOB, "manager"), id, {}, "POST");
    expect(moved.status).toBe(422);
    expect((await moved.json()).code).toBe("children_changed");
    expect(db.rows("sprints").some((s) => s.id === "spr-1")).toBe(true);
  });

  it("a record that vanished before approval closes the request (422 target_gone)", async () => {
    const id = await raise(ENTITIES[4]);
    db.tables.clashes = [];
    const res = await call(approve, session(BOB, "manager"), id, {}, "POST");
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("target_gone");
    expect(db.rows("deletion_requests")[0].status).toBe("withdrawn");
  });

  it("reject needs a reason and leaves the record; the requester can withdraw their own request", async () => {
    const id = await raise(ENTITIES[4], session(CARA, "manager"));
    expect((await call(reject, session(BOB, "manager"), id, {}, "POST")).status).toBe(422);
    expect((await call(reject, session(BOB, "manager"), id, { reason: "still needed" }, "POST")).status).toBe(200);
    expect(db.rows("clashes").some((c) => c.id === "clash-1")).toBe(true);

    const second = await raise(ENTITIES[4], session(CARA, "manager"));
    expect((await call(withdraw, session(BOB, "manager"), second, {}, "POST")).status).toBe(403);
    expect((await call(withdraw, session(CARA, "manager"), second, {}, "POST")).status).toBe(200);
    expect(db.rows("deletion_requests").find((r) => r.id === second)!.status).toBe("withdrawn");
  });

  it("allocation: approving re-checks the member's load", async () => {
    const id = await raise(ENTITIES[3]);
    expect(detect).not.toHaveBeenCalled();
    expect((await call(approve, session(BOB, "manager"), id, {}, "POST")).status).toBe(200);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0][2]).toBe("res-1");
    expect(db.rows("allocations").map((a) => a.id)).toEqual(["al-2"]);
  });
});
