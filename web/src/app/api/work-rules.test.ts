/**
 * Work-record rules from the common-pattern answers (2026-10-17):
 * Q-WRK-1 program attach, Q-WRK-2 duplicate clash, Q-WRK-4/5 sprint timing,
 * Q-WRK-14 milestone with open tasks, Q-WRK-15 reopen a complete project,
 * Q-WRK-18 unknown fields, Q-WRK-19 resolution note + risk escalation,
 * Q-WRK-20 sprint close/attach, Q-WRK-21 resolving a clash.
 *
 * Real route handlers against the in-memory admin client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";
import { closeSprintRpc } from "@/lib/sprints/fake-close-rpc";

const { holder, authHolder, notifySpy } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
  notifySpy: vi.fn(async () => undefined),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: () => undefined,
  emitApprovalDecided: () => undefined,
}));
vi.mock("@/lib/notify/publish", () => ({
  notify: notifySpy,
  resolveProjectOwner: async () => "owner-1",
  resolveWorkspaceApprovers: async () => [],
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

import { POST as createProject } from "./projects/route";
import { PATCH as patchProject } from "./projects/[id]/route";
import { POST as createClash } from "./clashes/route";
import { PATCH as patchClash } from "./clashes/[id]/route";
import { PATCH as patchMilestone } from "./milestones/[id]/route";
import { POST as createRisk } from "./projects/[id]/risks/route";
import { PATCH as patchRisk } from "./risks/[id]/route";
import { POST as createIssue } from "./projects/[id]/issues/route";
import { PATCH as patchIssue } from "./issues/[id]/route";
import { POST as createSprint, GET as listSprints } from "./sprints/route";
import { POST as closeSprint } from "./sprints/[id]/close/route";
import { POST as attachTask } from "./sprints/[id]/tasks/route";
import { POST as createTask } from "./projects/[id]/tasks/route";
import { PATCH as patchTask } from "./tasks/[id]/route";
import { POST as createAllocation } from "./allocations/route";
import { POST as createResource } from "./resources/route";
import { POST as createProgram } from "./programs/route";

const WS = "ws-1";
const U_MEMBER = "11111111-1111-4111-8111-111111111111";
const U_MANAGER = "22222222-2222-4222-8222-222222222222";
const PROJ = "44444444-4444-4444-8444-444444444441";
const PROG = "33333333-3333-4333-8333-333333333333";
const MEMBER_R = "55555555-5555-4555-8555-555555555551";
const MS = "88888888-8888-4888-8888-888888888881";
const RISK = "99999999-9999-4999-8999-999999999991";
const ISSUE = "99999999-9999-4999-8999-999999999992";
const CLASH_OPEN = "99999999-9999-4999-8999-999999999994";
const CLASH_DONE = "99999999-9999-4999-8999-999999999995";
const SP_ACTIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SP_NEXT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const SP_OTHER_PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const SP_PLANNED_OLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const T_DONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const T_OPEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const T_FREE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
const OTHER_PROJ = "44444444-4444-4444-8444-444444444442";

let db: FakeDb;

function seed(): FakeDb {
  return new FakeDb({
    projects: [
      {
        id: PROJ, workspace_id: WS, name: "Apollo", rag_status: "complete", program_id: null,
        is_locked: true, completion_pct: 100, updated_at: "2026-10-01T00:00:00Z",
      },
      { id: OTHER_PROJ, workspace_id: WS, name: "Other", is_locked: false },
    ],
    programs: [{ id: PROG, workspace_id: WS, name: "Platform" }],
    profiles: [
      { id: U_MEMBER, workspace_id: WS, role: "member" },
      { id: U_MANAGER, workspace_id: WS, role: "manager" },
    ],
    resource_members: [{ id: MEMBER_R, workspace_id: WS, name: "Casey" }],
    clashes: [
      { id: CLASH_OPEN, workspace_id: WS, reference_id: "CL-001", title: "Over", type: "resource", severity: "low", status: "open", resource_member_id: MEMBER_R },
      { id: CLASH_DONE, workspace_id: WS, reference_id: "CL-002", title: "Old", type: "schedule", severity: "low", status: "resolved", resource_member_id: MEMBER_R },
    ],
    milestones: [{ id: MS, workspace_id: WS, project_id: PROJ, name: "Go-live", status: "on_track", updated_at: "2026-10-01T00:00:00Z" }],
    risks: [{
      id: RISK, workspace_id: WS, project_id: PROJ, title: "Slip", status: "open", severity: "low", likelihood: "low",
      reference_id: "R-001", resolution: null, updated_at: "2026-10-01T00:00:00Z",
    }],
    issues: [{ id: ISSUE, workspace_id: WS, project_id: PROJ, title: "Bug", status: "open", resolution: null, updated_at: "2026-10-01T00:00:00Z" }],
    tasks: [
      { id: T_DONE, workspace_id: WS, project_id: PROJ, milestone_id: MS, name: "Done", status_type: "completed", sprint_id: SP_ACTIVE, story_points: 3, updated_at: "2026-10-01T00:00:00Z" },
      { id: T_OPEN, workspace_id: WS, project_id: PROJ, milestone_id: MS, name: "Open", status_type: "started", sprint_id: SP_ACTIVE, story_points: 2, updated_at: "2026-10-01T00:00:00Z" },
      { id: T_FREE, workspace_id: WS, project_id: PROJ, name: "Free", status_type: "backlog", sprint_id: null, updated_at: "2026-10-01T00:00:00Z" },
    ],
    sprints: [
      { id: SP_ACTIVE, workspace_id: WS, project_id: PROJ, name: "S1", state: "active", start_date: "2020-01-01", end_date: "2020-01-14", committed_snapshot: { [T_DONE]: 3, [T_OPEN]: 2 } },
      { id: SP_NEXT, workspace_id: WS, project_id: PROJ, name: "S2", state: "planned", start_date: "2099-01-01", end_date: "2099-01-14" },
      { id: SP_OTHER_PROJECT, workspace_id: WS, project_id: OTHER_PROJ, name: "X", state: "planned", start_date: "2099-01-01", end_date: "2099-01-14" },
      { id: SP_PLANNED_OLD, workspace_id: WS, project_id: PROJ, name: "S0", state: "planned", start_date: "2020-02-01", end_date: "2020-02-14" },
    ],
  });
}

const actor = (id: string, role: string): Actor => ({
  type: "user", id, label: role, workspaceId: WS, role, principalId: id, principalRole: role, channel: "ui", requestId: "r",
});

type Handler = (req: NextRequest, ctx: { params?: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: Handler, method: string, body: unknown, params: Record<string, string> = {}) {
  const req = new NextRequest("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler(req, { params: Promise.resolve(params) });
}

const rows = (t: string) => db.rows(t);
const row = (t: string, id: string) => rows(t).find((r) => r.id === id)!;
const lastAudit = () => rows("audit_log")[rows("audit_log").length - 1];

beforeEach(() => {
  db = seed();
  db.rpcHandlers.nopm_close_sprint = closeSprintRpc;
  holder.db = db;
  authHolder.actor = actor(U_MANAGER, "manager");
  notifySpy.mockClear();
});

describe("Q-WRK-1 program attach (manager or admin, also while locked)", () => {
  it("a member cannot move a project into a program (403)", async () => {
    authHolder.actor = actor(U_MEMBER, "member");
    const res = await call(patchProject, "PATCH", { program_id: PROG }, { id: PROJ });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("manager or admin");
    expect(row("projects", PROJ).program_id).toBeNull();
  });
  it("a manager can, on a LOCKED project", async () => {
    const res = await call(patchProject, "PATCH", { program_id: PROG }, { id: PROJ });
    expect(res.status).toBe(200);
    expect(row("projects", PROJ).program_id).toBe(PROG);
  });
  it("a member echoing the stored program_id is not a change", async () => {
    row("projects", PROJ).program_id = PROG;
    authHolder.actor = actor(U_MEMBER, "member");
    const res = await call(patchProject, "PATCH", { program_id: PROG, name: "Apollo 2" }, { id: PROJ });
    expect(res.status).toBe(200);
  });
  it("a member cannot create a project straight into a program", async () => {
    authHolder.actor = actor(U_MEMBER, "member");
    const res = await call(createProject, "POST", { code: "N1", name: "New", program_id: PROG });
    expect(res.status).toBe(403);
  });
});

describe("Q-WRK-15 a complete project is reopened by a manager", () => {
  it("a member cannot move rag_status away from complete", async () => {
    authHolder.actor = actor(U_MEMBER, "member");
    const res = await call(patchProject, "PATCH", { rag_status: "green" }, { id: PROJ });
    expect(res.status).toBe(403);
    expect(row("projects", PROJ).rag_status).toBe("complete");
  });
  it("a manager can; health is otherwise free for anyone", async () => {
    expect((await call(patchProject, "PATCH", { rag_status: "amber" }, { id: PROJ })).status).toBe(200);
    authHolder.actor = actor(U_MEMBER, "member");
    expect((await call(patchProject, "PATCH", { rag_status: "red" }, { id: PROJ })).status).toBe(200);
  });
});

describe("Q-WRK-18 unknown fields are refused, nothing is saved", () => {
  it('PATCH /projects/:id: { colour } -> 422 with the exact message', async () => {
    const res = await call(patchProject, "PATCH", { name: "X", colour: "red" }, { id: PROJ });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Unknown field "colour". Nothing was saved.');
    expect(body.fields).toEqual([{ field: "colour", message: 'Unknown field "colour". Nothing was saved.' }]);
    expect(row("projects", PROJ).name).toBe("Apollo");
  });
  it("is_locked is refused on create and on update", async () => {
    expect((await call(createProject, "POST", { code: "N", name: "N", is_locked: true })).status).toBe(422);
    expect((await call(patchProject, "PATCH", { is_locked: false }, { id: PROJ })).status).toBe(422);
  });
  it("names several unknown fields at once", async () => {
    const res = await call(patchProject, "PATCH", { a: 1, b: 2 }, { id: PROJ });
    expect((await res.json()).error).toBe('Unknown fields "a", "b". Nothing was saved.');
  });
  it.each([
    ["POST task", createTask, "POST", { name: "T", bogus: 1 }, { id: OTHER_PROJ }],
    ["PATCH task", patchTask, "PATCH", { bogus: 1 }, { id: T_FREE }],
    ["POST allocation", createAllocation, "POST", { member_id: MEMBER_R, bogus: 1 }, {}],
    ["POST resource", createResource, "POST", { name: "R", bogus: 1 }, {}],
    ["POST program", createProgram, "POST", { name: "P", bogus: 1 }, {}],
    ["POST sprint", createSprint, "POST", { project_id: PROJ, name: "S", start_date: "2026-01-01", end_date: "2026-01-02", bogus: 1 }, {}],
    ["POST clash", createClash, "POST", { title: "C", type: "schedule", severity: "low", bogus: 1 }, {}],
    ["PATCH milestone", patchMilestone, "PATCH", { bogus: 1 }, { id: MS }],
    ["PATCH risk", patchRisk, "PATCH", { bogus: 1 }, { id: RISK }],
    ["PATCH issue", patchIssue, "PATCH", { bogus: 1 }, { id: ISSUE }],
  ] as const)("%s", async (_n, handler, method, body, params) => {
    const before = rows("audit_log").length;
    const res = await call(handler as Handler, method, body, params as Record<string, string>);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('Unknown field "bogus". Nothing was saved.');
    expect(rows("audit_log")).toHaveLength(before);
  });
});

describe("Q-WRK-2 one open clash per person and type", () => {
  const base = { title: "Again", type: "resource", severity: "low", resource_member_id: MEMBER_R };
  it("a second live clash for the same person and type is a 422 duplicate_clash", async () => {
    const res = await call(createClash, "POST", base);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("duplicate_clash");
    expect(body.error).toContain("CL-001");
    expect(rows("clashes")).toHaveLength(2);
  });
  it("another type, a resolved one, or no person is fine", async () => {
    expect((await call(createClash, "POST", { ...base, type: "dependency" })).status).toBe(201);
    expect((await call(createClash, "POST", { title: "P", type: "resource", severity: "low" })).status).toBe(201);
  });
  it("reopening a resolved clash that would duplicate a live one is refused", async () => {
    // CLASH_DONE is a schedule clash for the same person; make it resource, then reopen.
    row("clashes", CLASH_DONE).type = "resource";
    const res = await call(patchClash, "PATCH", { status: "open" }, { id: CLASH_DONE });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("duplicate_clash");
  });
  it("editing the live clash itself is not a duplicate of itself", async () => {
    const res = await call(patchClash, "PATCH", { status: "investigating" }, { id: CLASH_OPEN });
    expect(res.status).toBe(200);
  });
});

describe("Q-WRK-21 who resolves a clash", () => {
  it("a member cannot resolve by hand; a manager can (with a reason)", async () => {
    authHolder.actor = actor(U_MEMBER, "member");
    const denied = await call(patchClash, "PATCH", { status: "resolved", resolution: "ok" }, { id: CLASH_OPEN });
    expect(denied.status).toBe(403);
    expect(row("clashes", CLASH_OPEN).status).toBe("open");

    authHolder.actor = actor(U_MANAGER, "manager");
    const ok = await call(patchClash, "PATCH", { status: "resolved", resolution: "Accepted: covered by contractor" }, { id: CLASH_OPEN });
    expect(ok.status).toBe(200);
    expect(row("clashes", CLASH_OPEN).resolution).toContain("Accepted");
    expect(lastAudit().action).toBe("clash.update");
  });
  it("a member can still move a clash to investigating", async () => {
    authHolder.actor = actor(U_MEMBER, "member");
    expect((await call(patchClash, "PATCH", { status: "investigating" }, { id: CLASH_OPEN })).status).toBe(200);
  });
});

describe("Q-WRK-14 completing a milestone with open tasks", () => {
  it("is warned first (422 open_tasks) and nothing changes", async () => {
    const res = await call(patchMilestone, "PATCH", { status: "completed" }, { id: MS });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("open_tasks");
    expect(body.error).toBe("1 task is still open. Complete this milestone anyway?");
    expect(row("milestones", MS).status).toBe("on_track");
  });
  it("goes through with confirm_open_tasks and records it in the one audit row", async () => {
    const before = rows("audit_log").length;
    const res = await call(patchMilestone, "PATCH", { status: "completed", confirm_open_tasks: true }, { id: MS });
    expect(res.status).toBe(200);
    expect(row("milestones", MS).status).toBe("completed");
    expect(row("milestones", MS)).not.toHaveProperty("confirm_open_tasks");
    expect(rows("audit_log")).toHaveLength(before + 1);
    expect((lastAudit().after as Record<string, unknown>).completed_with_open_tasks).toBe(1);
  });
  it("needs no confirm when every task is finished", async () => {
    row("tasks", T_OPEN).status_type = "canceled";
    expect((await call(patchMilestone, "PATCH", { status: "completed" }, { id: MS })).status).toBe(200);
  });
});

describe("Q-WRK-19 closing a risk or issue needs a resolution note", () => {
  const MSG = "Add a short note on how this was resolved.";
  it("risk: closing without a note is refused", async () => {
    const res = await call(patchRisk, "PATCH", { status: "closed" }, { id: RISK });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe(MSG);
    expect(body.fields).toEqual([{ field: "resolution", message: MSG }]);
    expect(row("risks", RISK).status).toBe("open");
  });
  it("risk: a blank note does not count; a real one does and is saved", async () => {
    expect((await call(patchRisk, "PATCH", { status: "closed", resolution: "   " }, { id: RISK })).status).toBe(422);
    const ok = await call(patchRisk, "PATCH", { status: "closed", resolution: "Vendor delivered early" }, { id: RISK });
    expect(ok.status).toBe(200);
    expect(row("risks", RISK).resolution).toBe("Vendor delivered early");
  });
  it("risk: an already-closed risk can be edited without a new note", async () => {
    Object.assign(row("risks", RISK), { status: "closed", resolution: null });
    expect((await call(patchRisk, "PATCH", { title: "Slip (closed)" }, { id: RISK })).status).toBe(200);
  });
  it("risk: cannot be created closed without a note", async () => {
    const res = await call(createRisk, "POST", { title: "R", severity: "low", likelihood: "low", status: "closed" }, { id: PROJ });
    expect(res.status).toBe(422);
  });
  it("issue: resolved/closed without a note is refused; with one it passes", async () => {
    expect((await call(patchIssue, "PATCH", { status: "resolved" }, { id: ISSUE })).status).toBe(422);
    expect((await call(patchIssue, "PATCH", { status: "closed", resolution: "Patched in 1.2" }, { id: ISSUE })).status).toBe(200);
    expect((await call(createIssue, "POST", { title: "I", priority: "low", status: "closed" }, { id: PROJ })).status).toBe(422);
  });
  it("owner is alerted on EVERY later increase, not only when reaching high", async () => {
    await call(patchRisk, "PATCH", { severity: "medium" }, { id: RISK });
    expect(notifySpy).toHaveBeenCalledTimes(1);
    notifySpy.mockClear();
    await call(patchRisk, "PATCH", { likelihood: "medium" }, { id: RISK });
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });
  it("and stays quiet on a decrease or an unrelated edit", async () => {
    Object.assign(row("risks", RISK), { severity: "high" });
    await call(patchRisk, "PATCH", { severity: "medium" }, { id: RISK });
    await call(patchRisk, "PATCH", { title: "Renamed" }, { id: RISK });
    expect(notifySpy).not.toHaveBeenCalled();
  });
});

describe("Q-WRK-4 / Q-WRK-5 sprint timing flags (flag only, never auto-act)", () => {
  it("GET /sprints flags a planned sprint past its start and an active one past its end", async () => {
    const res = await call(listSprints, "GET", undefined);
    const body = await res.json();
    const byId = Object.fromEntries((body.data as { id: string; timing_flag: string | null; state: string }[]).map((s) => [s.id, s]));
    expect(byId[SP_ACTIVE].timing_flag).toBe("past_end");
    expect(byId[SP_PLANNED_OLD].timing_flag).toBe("late_to_start");
    expect(byId[SP_NEXT].timing_flag).toBeNull();
    // nothing started or closed by itself
    expect(row("sprints", SP_ACTIVE).state).toBe("active");
    expect(row("sprints", SP_PLANNED_OLD).state).toBe("planned");
  });
});

describe("Q-WRK-20 closing a sprint asks where the unfinished tasks go", () => {
  it("refuses without a choice (422 unfinished_tasks) and changes nothing", async () => {
    const res = await call(closeSprint, "POST", undefined, { id: SP_ACTIVE });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("unfinished_tasks");
    expect(body.error).toContain("1 task is not finished");
    expect(row("sprints", SP_ACTIVE).state).toBe("active");
    expect(row("tasks", T_OPEN).sprint_id).toBe(SP_ACTIVE);
  });
  it("backlog: unfinished leave the sprint, finished stay as history; one audit row", async () => {
    const before = rows("audit_log").length;
    const res = await call(closeSprint, "POST", { move_unfinished_to: "backlog" }, { id: SP_ACTIVE });
    expect(res.status).toBe(200);
    expect(row("sprints", SP_ACTIVE).state).toBe("closed");
    expect(row("sprints", SP_ACTIVE).completed_points).toBe(3);
    expect(row("tasks", T_OPEN).sprint_id).toBeNull();
    expect(row("tasks", T_DONE).sprint_id).toBe(SP_ACTIVE);
    expect(rows("audit_log")).toHaveLength(before + 1);
    expect((lastAudit().after as { moved_unfinished: unknown }).moved_unfinished).toEqual({ to: "backlog", task_ids: [T_OPEN] });
  });
  it("to the next sprint of the same project", async () => {
    const res = await call(closeSprint, "POST", { move_unfinished_to: SP_NEXT }, { id: SP_ACTIVE });
    expect(res.status).toBe(200);
    expect(row("tasks", T_OPEN).sprint_id).toBe(SP_NEXT);
  });
  it("a sprint of another project is not a valid destination", async () => {
    const res = await call(closeSprint, "POST", { move_unfinished_to: SP_OTHER_PROJECT }, { id: SP_ACTIVE });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("invalid_destination");
    expect(row("sprints", SP_ACTIVE).state).toBe("active");
  });
  it("no choice is needed when everything is finished", async () => {
    row("tasks", T_OPEN).status_type = "completed";
    expect((await call(closeSprint, "POST", undefined, { id: SP_ACTIVE })).status).toBe(200);
  });
  it("a task attached after the start is marked scope_added in the audit row", async () => {
    const res = await call(attachTask, "POST", { task_id: T_FREE }, { id: SP_ACTIVE });
    expect(res.status).toBe(200);
    expect((lastAudit().after as { scope_added?: boolean }).scope_added).toBe(true);
  });
  it("a task attached before the start is not", async () => {
    const res = await call(attachTask, "POST", { task_id: T_FREE }, { id: SP_NEXT });
    expect(res.status).toBe(200);
    expect(lastAudit().after).toEqual({ task_id: T_FREE });
  });
});
