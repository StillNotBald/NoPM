/**
 * Lifecycle guards, second pass — the lock / child-count / budget / race fixes
 * from the governance code review (CR-gov P1-1, P1-3, P2-1, P2-9, P2-12, P2-14
 * and the budget note), at the HTTP edge.
 *
 * Same harness as lifecycle-guards.test.ts: the real route handlers (wrapped by
 * route()) over the in-memory admin client; requireAuth is mocked, requireScope
 * is the real one. Three database behaviours the in-memory client does not have
 * are simulated here, next to the tests that need them, instead of widening the
 * shared fake:
 *   - `.is()` filters (the lock route selects rows whose baseline IS NULL);
 *   - the 0028 lock backstop (a baseline_* write on a LOCKED project raises
 *     P0010) — so the lock route's write ORDER is actually observable;
 *   - a unique-index / trigger error on one chosen write (failNext).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb, type Row } from "@/lib/governance/test-support/fake-admin";
import { timesheetContentDigest } from "@/lib/governance/timesheet-decision";

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
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

import { POST as createProject } from "./projects/route";
import { POST as lockProject } from "./projects/[id]/lock/route";
import { DELETE as deleteProject } from "./projects/[id]/route";
import { PUT as putBudget, PATCH as patchBudget } from "./projects/[id]/budget/route";
import { PATCH as patchTask, DELETE as deleteTask } from "./tasks/[id]/route";
import { PATCH as patchMilestone } from "./milestones/[id]/route";
import { POST as applyRebaseline } from "./rebaselines/[id]/apply/route";
import { POST as submitTimesheet } from "./timesheet-submissions/route";
import { POST as decideTimesheet } from "./timesheet-submissions/[id]/decision/route";
import { DELETE as deleteResource } from "./resources/[id]/route";
import { POST as approveDeletion } from "./deletion-requests/[id]/approve/route";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CASEY = "77777777-7777-4777-8777-777777777777"; // the person the MEMBER resource row belongs to
const DANA = "88888888-8888-4888-8888-888888888888"; // another plain member
const STRANGER = "99999999-9999-4999-8999-999999999999"; // an admin of ANOTHER workspace
const MEMBER_2 = "33333333-3333-4333-8333-333333333334"; // a resource row with no linked profile
const MEMBER = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444445";
// MS_1 and MS_2 share their first sixteen characters: a truncating id comparison would call them the same.
const MS_1 = "55555555-5555-4555-8555-555555555555";
const MS_2 = "55555555-5555-4555-8555-555555555556";
const TASK_1 = "66666666-6666-4666-8666-666666666666";

const SCOPES = [
  "project:read",
  "project:write",
  "project:delete:request",
  "project:delete:approve",
  "task:write",
  "task:delete:request",
  "milestone:write",
  "resource:write",
  "budget:write",
  "time:submit",
  "time:approve",
  "rebaseline:approve",
];

function pat(id: string, owner: string | null): Actor {
  return {
    type: "token",
    id,
    tokenId: id,
    label: `${id}-agent`,
    workspaceId: WS,
    scopes: SCOPES,
    principalId: owner,
    principalRole: owner ? "manager" : null,
    channel: "api",
    requestId: `req-${id}`,
  };
}
const alicePat = () => pat("tok-alice", ALICE);
const bobPat = () => pat("tok-bob", BOB);

let db: FakeDb;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function call(handler: Handler, actor: Actor, id: string, body?: unknown, method = "POST") {
  authHolder.actor = actor;
  const req = new NextRequest(`http://localhost/api/x/${id}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handler(req, { params: Promise.resolve({ id }) });
}

async function expectRule(res: Response, code: string, status = 422) {
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(status);
  expect(json.code, JSON.stringify(json)).toBe(code);
  return json;
}

const row = (table: string, id: string) => db.rows(table).find((r) => r.id === id) as Row;
const project = () => row("projects", PROJECT);
const auditActions = () => db.rows("audit_log").map((r) => r.action);

// ── simulated database behaviours ─────────────────────────────────────────

// FakeDb has no `.is()`; add it to the builder's prototype for this file only.
const builderProto = Object.getPrototypeOf(new FakeDb().client.from("t")) as {
  is?: (this: { filters: Array<(r: Row) => boolean> }, column: string, value: unknown) => unknown;
};
builderProto.is = function (this, column, value) {
  this.filters.push((r) => (r[column] ?? null) === value);
  return this;
};

/** A query chain whose every step returns itself and whose result is `{ data: null, error }`. */
function failingChain(error: { code: string; message: string }) {
  const result = { data: null, error };
  const chain: unknown = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
        if (prop === "single" || prop === "maybeSingle") return () => Promise.resolve(result);
        return () => chain;
      },
    },
  );
  return chain;
}

/** The next `op` on `table` fails with `error`; everything else behaves normally. */
function failNext(fake: FakeDb, table: string, op: "insert" | "update" | "delete", error: { code: string; message: string }) {
  const realFrom = fake.client.from;
  let armed = true;
  fake.client.from = (t: string) => {
    const builder = realFrom(t) as unknown as Record<string, unknown>;
    if (t === table && armed) {
      builder[op] = () => {
        armed = false;
        return failingChain(error);
      };
    }
    return builder as never;
  };
}

/** Migration 0028: once a project is locked, a baseline_* write on its milestones / tasks raises PROJECT_LOCKED (P0010). */
function simulateLockBackstop(fake: FakeDb) {
  const realFrom = fake.client.from;
  fake.client.from = (table: string) => {
    const builder = realFrom(table) as unknown as { update: (patch: Row) => unknown };
    if (table === "milestones" || table === "tasks") {
      const update = builder.update.bind(builder);
      builder.update = (patch: Row) => {
        const touchesBaseline = Object.keys(patch).some((k) => k.startsWith("baseline_"));
        if (touchesBaseline && fake.rows("projects").some((p) => p.is_locked)) {
          return failingChain({ code: "P0010", message: "PROJECT_LOCKED: project schedule is frozen" });
        }
        return update(patch);
      };
    }
    return builder as never;
  };
}

// ── seed ──────────────────────────────────────────────────────────────────

const STAMP = "2026-10-01T00:00:00.000Z";

function seed(): FakeDb {
  return new FakeDb({
    projects: [
      { id: PROJECT, workspace_id: WS, name: "Billing Migration", is_locked: false, updated_at: STAMP },
      { id: OTHER_PROJECT, workspace_id: WS, name: "Other", is_locked: false, updated_at: STAMP },
    ],
    milestones: [
      { id: MS_1, workspace_id: WS, project_id: PROJECT, name: "Go-live", target_date: "2027-03-01", baseline_target_date: null, start_date: null, status: "not_started", updated_at: STAMP },
      { id: MS_2, workspace_id: WS, project_id: PROJECT, name: "No date yet", target_date: null, baseline_target_date: null, start_date: null, status: "not_started", updated_at: STAMP },
      { id: "ms-baselined", workspace_id: WS, project_id: PROJECT, name: "Already baselined", target_date: "2027-05-01", baseline_target_date: "2027-04-15", start_date: null, status: "not_started", updated_at: STAMP },
      { id: "ms-other", workspace_id: WS, project_id: OTHER_PROJECT, name: "Other project", target_date: "2027-06-01", baseline_target_date: null, start_date: null, status: "not_started", updated_at: STAMP },
    ],
    tasks: [
      { id: TASK_1, workspace_id: WS, project_id: PROJECT, milestone_id: MS_1, name: "Migrate billing DB", status_type: "backlog", start_date: "2027-02-01", due_date: "2027-02-10", estimate_hours: 12.5, baseline_start_date: null, baseline_due_date: null, updated_at: STAMP },
      { id: "task-undated", workspace_id: WS, project_id: PROJECT, milestone_id: null, name: "Undated", start_date: null, due_date: null, baseline_start_date: null, baseline_due_date: null, updated_at: STAMP },
      { id: "task-baselined", workspace_id: WS, project_id: PROJECT, milestone_id: null, name: "Baselined", start_date: "2027-02-15", due_date: "2027-02-20", baseline_start_date: "2027-01-01", baseline_due_date: "2027-01-05", updated_at: STAMP },
      { id: "task-other", workspace_id: WS, project_id: OTHER_PROJECT, milestone_id: null, name: "Other project", start_date: "2027-02-01", due_date: "2027-02-02", baseline_start_date: null, baseline_due_date: null, updated_at: STAMP },
    ],
    resource_members: [
      { id: MEMBER, workspace_id: WS, name: "Casey Member", cost_rate: 10, profile_id: CASEY },
      { id: MEMBER_2, workspace_id: WS, name: "Unlinked Member", cost_rate: 10, profile_id: null },
    ],
    time_entries: [
      { id: "te-1", workspace_id: WS, member_id: MEMBER, project_id: PROJECT, entry_date: "2026-10-13", hours: 8, billable: true },
    ],
    timesheet_submissions: [],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "admin" },
      { id: BOB, workspace_id: WS, role: "manager" },
      { id: CASEY, workspace_id: WS, role: "member" },
      { id: DANA, workspace_id: WS, role: "member" },
      { id: STRANGER, workspace_id: "ws-2", role: "admin" },
    ],
    rebaselines: [
      { id: "rb-approved", workspace_id: WS, project_id: PROJECT, version: 1, status: "approved", requested_by: ALICE, requested_principal_id: ALICE },
    ],
    deletion_requests: [],
    project_budget: [],
    clashes: [],
    calendar_feeds: [],
    audit_log: [],
    notifications: [],
  });
}

beforeEach(() => {
  db = seed();
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── P1-1: locking snapshots the baselines while the project is still open ──

describe("P1-1 — POST /projects/:id/lock captures the baselines, then locks", () => {
  beforeEach(() => simulateLockBackstop(db));

  it("the harness is not vacuous: once locked, a baseline write is refused with P0010", async () => {
    project().is_locked = true;
    const { error } = await db.client.from("milestones").update({ baseline_target_date: "2027-03-01" }).eq("id", MS_1);
    expect((error as { code?: string } | null)?.code).toBe("P0010");
  });

  it("a dated milestone and task with null baselines: 200, project locked, baselines set", async () => {
    const res = await call(lockProject, alicePat(), PROJECT, { reason: "Q4 baseline" });
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(200);

    expect(project()).toMatchObject({ is_locked: true, lock_reason: "Q4 baseline" });
    expect(row("milestones", MS_1).baseline_target_date).toBe("2027-03-01");
    expect(row("tasks", TASK_1)).toMatchObject({ baseline_start_date: "2027-02-01", baseline_due_date: "2027-02-10" });
  });

  it("only never-baselined rows with a date are snapshotted; existing baselines and other projects are untouched", async () => {
    await call(lockProject, alicePat(), PROJECT);

    expect(row("milestones", MS_2).baseline_target_date).toBeNull(); // no date, nothing to capture
    expect(row("milestones", "ms-baselined").baseline_target_date).toBe("2027-04-15"); // kept
    expect(row("tasks", "task-undated")).toMatchObject({ baseline_start_date: null, baseline_due_date: null });
    expect(row("tasks", "task-baselined")).toMatchObject({ baseline_start_date: "2027-01-01", baseline_due_date: "2027-01-05" });
    expect(row("milestones", "ms-other").baseline_target_date).toBeNull();
    expect(row("tasks", "task-other").baseline_start_date).toBeNull();
    expect(row("projects", OTHER_PROJECT).is_locked).toBe(false);
  });

  it("writes exactly one project.lock audit row, after the snapshot", async () => {
    await call(lockProject, alicePat(), PROJECT);
    expect(auditActions()).toEqual(["project.lock"]);
    expect(db.rows("audit_log")[0].after).toMatchObject({ is_locked: true });
  });

  it("the snapshot, the lock and the audit row are ONE RPC: a failure leaves the project OPEN, un-baselined and un-audited, and a retry finishes the job", async () => {
    const real = db.rpcHandlers.nopm_lock_project;
    db.rpcHandlers.nopm_lock_project = () => ({ data: null, error: { code: "XX000", message: "connection reset" } });
    const failed = await call(lockProject, alicePat(), PROJECT);
    expect(failed.status).toBe(500);
    expect(project().is_locked).toBe(false);
    expect(row("tasks", TASK_1).baseline_due_date).toBeNull();
    expect(auditActions()).toEqual([]);

    db.rpcHandlers.nopm_lock_project = real;
    const retry = await call(lockProject, alicePat(), PROJECT);
    expect(retry.status).toBe(200);
    expect(row("tasks", TASK_1).baseline_due_date).toBe("2027-02-10");
    expect(row("milestones", MS_1).baseline_target_date).toBe("2027-03-01");
    expect(auditActions()).toEqual(["project.lock"]);
  });

  it("locking an already-locked project does not try to write baselines (the triggers would refuse) and still answers 200", async () => {
    project().is_locked = true;
    const res = await call(lockProject, alicePat(), PROJECT, { reason: "again" });
    expect(res.status).toBe(200);
    expect(row("milestones", MS_1).baseline_target_date).toBeNull();
    expect(project().lock_reason).toBe("again");
  });
});

// ── P1-3: the deletion scope guard sees budget, clashes and calendar feeds ──

describe("P1-3 — a project deletion is refused when budget / clash / calendar-feed rows appear after the request", () => {
  async function requestDeletion(): Promise<string> {
    const res = await call(deleteProject, alicePat(), PROJECT, { reason: "cancelled" }, "DELETE");
    expect(res.status).toBe(202);
    return String(db.rows("deletion_requests")[0].id);
  }

  it("the request snapshot carries a count for all fifteen child tables", async () => {
    await requestDeletion();
    const counts = (db.rows("deletion_requests")[0].before as { child_counts: Record<string, number> }).child_counts;
    expect(Object.keys(counts)).toEqual(expect.arrayContaining(["project_budget", "clashes", "calendar_feeds"]));
    expect(Object.keys(counts)).toHaveLength(15);
  });

  it.each([
    ["project_budget", { id: "pb-1", workspace_id: WS, project_id: PROJECT }],
    ["calendar_feeds", { id: "cf-1", workspace_id: WS, project_id: PROJECT }],
    ["clashes (named as project A)", { id: "cl-a", workspace_id: WS, project_a_id: PROJECT, project_b_id: OTHER_PROJECT }],
    ["clashes (named as project B)", { id: "cl-b", workspace_id: WS, project_a_id: OTHER_PROJECT, project_b_id: PROJECT }],
  ])("%s: approval is refused (422 children_changed), the project survives and the request stays pending", async (name, added) => {
    const id = await requestDeletion();
    db.rows(name.split(" ")[0]).push(added);

    await expectRule(await call(approveDeletion, bobPat(), id, {}), "children_changed");
    expect(db.rows("projects")).toHaveLength(2);
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
  });

  it("end to end: someone PUTs a budget through the API after the request, and the approval is refused", async () => {
    const id = await requestDeletion();
    const put = await call(putBudget, bobPat(), PROJECT, { planned_amount: 5000 }, "PUT");
    expect(put.status).toBe(200);

    await expectRule(await call(approveDeletion, bobPat(), id, {}), "children_changed");
    expect(db.rows("project_budget")).toHaveLength(1);
  });

  it("a clash that names only OTHER projects does not count", async () => {
    const id = await requestDeletion();
    db.rows("clashes").push({ id: "cl-x", workspace_id: WS, project_a_id: OTHER_PROJECT, project_b_id: OTHER_PROJECT });
    expect((await call(approveDeletion, bobPat(), id, {})).status).toBe(200);
    expect(db.rows("projects")).toHaveLength(1);
  });
});

// ── P2-1: a no-op echo on a locked project is not a change ─────────────────

describe("P2-1 — task and milestone PATCH under a lock compare VALUES, like the DB trigger", () => {
  beforeEach(() => {
    project().is_locked = true;
  });

  const echoTask = () => ({
    name: "Migrate billing DB",
    status_type: "backlog",
    milestone_id: MS_1,
    start_date: "2027-02-01",
    due_date: "2027-02-10",
    estimate_hours: 12.5,
  });

  it("a full-record echo of a task is 200 with no *.update.blocked audit row", async () => {
    const res = await call(patchTask, alicePat(), TASK_1, echoTask(), "PATCH");
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(auditActions()).toEqual(["task.update"]);
    expect(auditActions().some((a) => String(a).endsWith(".blocked"))).toBe(false);
  });

  it("...even when the echo spells the same values differently (ISO timestamp, 12.50)", async () => {
    const res = await call(patchTask, alicePat(), TASK_1, { ...echoTask(), due_date: "2027-02-10T00:00:00.000Z", estimate_hours: 12.50 }, "PATCH");
    expect(res.status).toBe(200);
  });

  it.each([
    ["due_date", { due_date: "2027-03-01" }],
    ["start_date", { start_date: "2027-01-15" }],
    ["estimate_hours", { estimate_hours: 40 }],
    ["milestone_id (differs only after the tenth character)", { milestone_id: MS_2 }],
    ["milestone_id cleared", { milestone_id: null }],
  ])("a real change of %s is 422 project_locked, audited as blocked with the field named, and nothing is written", async (field, patch) => {
    const key = Object.keys(patch)[0];
    const res = await call(patchTask, alicePat(), TASK_1, { ...echoTask(), ...patch }, "PATCH");
    await expectRule(res, "project_locked");
    expect(auditActions()).toEqual(["task.update.blocked"]);
    expect(db.rows("audit_log")[0].after).toMatchObject({ reason: "project_locked", fields: [key] });
    expect(row("tasks", TASK_1)[key]).toBe(seed().rows("tasks")[0][key]);
  });

  it("status and other day-to-day edits stay live", async () => {
    const res = await call(patchTask, alicePat(), TASK_1, { status_type: "started", completion_pct: 40 }, "PATCH");
    expect(res.status).toBe(200);
    expect(row("tasks", TASK_1)).toMatchObject({ status_type: "started", completion_pct: 40 });
  });

  it("an unlocked project takes the real date change", async () => {
    project().is_locked = false;
    const res = await call(patchTask, alicePat(), TASK_1, { due_date: "2027-03-01" }, "PATCH");
    expect(res.status).toBe(200);
    expect(row("tasks", TASK_1).due_date).toBe("2027-03-01");
  });

  it("a milestone echo (target_date as an ISO timestamp of the stored day) is 200, no blocked row", async () => {
    const res = await call(patchMilestone, alicePat(), MS_1, { name: "Go-live", target_date: "2027-03-01T00:00:00.000Z", status: "on_track" }, "PATCH");
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(auditActions()).toEqual(["milestone.update"]);
  });

  it("a real milestone date change is 422 project_locked with the field named", async () => {
    const res = await call(patchMilestone, alicePat(), MS_1, { target_date: "2027-04-01T00:00:00.000Z" }, "PATCH");
    await expectRule(res, "project_locked");
    expect(auditActions()).toEqual(["milestone.update.blocked"]);
    expect(db.rows("audit_log")[0].after).toMatchObject({ fields: ["target_date"] });
    expect(row("milestones", MS_1).target_date).toBe("2027-03-01");
  });

  it("setting a date on a milestone that had none is a real change", async () => {
    const res = await call(patchMilestone, alicePat(), MS_2, { target_date: "2027-09-01T00:00:00.000Z" }, "PATCH");
    await expectRule(res, "project_locked");
  });
});

// ── P2-9: apply runs the snapshot before the terminal status flip ──────────

describe("P2-9 — POST /rebaselines/:id/apply (one atomic RPC, migration 0062)", () => {
  beforeEach(() => {
    project().is_locked = true; // a sign-off is for a LOCKED project
  });

  it("flips approved -> applied and writes the single rebaseline.apply audit row in the same call", async () => {
    const res = await call(applyRebaseline, bobPat(), "rb-approved");
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(db.rows("rebaselines")[0]).toMatchObject({ status: "applied" });
    expect(auditActions()).toEqual(["rebaseline.apply"]);
    expect(db.rpcCallsTo("nopm_apply_rebaseline")[0].args).toMatchObject({
      p_rebaseline_id: "rb-approved",
      p_workspace_id: WS,
      p_approver_principal_id: BOB,
    });
  });

  it("a failure inside the RPC leaves the rebaseline approved and un-audited, so it can be retried", async () => {
    const real = db.rpcHandlers.nopm_apply_rebaseline;
    db.rpcHandlers.nopm_apply_rebaseline = () => ({ data: null, error: { code: "XX000", message: "deadlock detected" } });
    const res = await call(applyRebaseline, bobPat(), "rb-approved");
    expect(res.status).toBe(500);
    expect(db.rows("rebaselines")[0]).toMatchObject({ status: "approved" });
    expect(auditActions()).toEqual([]);

    db.rpcHandlers.nopm_apply_rebaseline = real;
    expect((await call(applyRebaseline, bobPat(), "rb-approved")).status).toBe(200);
    expect(db.rows("rebaselines")[0]).toMatchObject({ status: "applied" });
  });

  it("losing the race (the RPC finds it no longer approved) is still 422 already_applied, with no audit row for the loser", async () => {
    db.rpcHandlers.nopm_apply_rebaseline = () => ({ data: null, error: { code: "P0001", message: "ALREADY_DECIDED" } });
    await expectRule(await call(applyRebaseline, bobPat(), "rb-approved"), "already_applied");
    expect(auditActions()).toEqual([]);
  });

  it("D11: a project that is no longer locked refuses the apply (422 project_not_locked), nothing moves", async () => {
    project().is_locked = false;
    await expectRule(await call(applyRebaseline, bobPat(), "rb-approved"), "project_not_locked");
    expect(db.rows("rebaselines")[0]).toMatchObject({ status: "approved" });
    expect(auditActions()).toEqual([]);
  });
});

// ── P2-14: unique-index races answer with the pre-check's 422 ──────────────

describe("P2-14 — a lost unique-index race is the same 422 as the pre-check, not a 500", () => {
  const raced = (index: string) => ({
    code: "23505",
    message: `duplicate key value violates unique constraint "${index}"`,
  });

  it("timesheet submit: uniq_open_timesheet -> 422 duplicate_submission, nothing audited", async () => {
    failNext(db, "timesheet_submissions", "insert", raced("uniq_open_timesheet"));
    await expectRule(
      await call(submitTimesheet, alicePat(), "x", { member_id: MEMBER, period_start: "2026-10-12" }),
      "duplicate_submission",
    );
    expect(auditActions()).toEqual([]);
  });

  it("timesheet submit: any OTHER insert error is still a 500", async () => {
    failNext(db, "timesheet_submissions", "insert", { code: "XX000", message: "connection reset" });
    const res = await call(submitTimesheet, alicePat(), "x", { member_id: MEMBER, period_start: "2026-10-12" });
    expect(res.status).toBe(500);
  });

  it("task deletion request: uniq_pending_deletion -> 422 duplicate_deletion_request", async () => {
    failNext(db, "deletion_requests", "insert", raced("uniq_pending_deletion"));
    const json = await expectRule(
      await call(deleteTask, alicePat(), TASK_1, { reason: "obsolete" }, "DELETE"),
      "duplicate_deletion_request",
    );
    expect(json.error).toContain("task");
    expect(db.rows("deletion_requests")).toHaveLength(0);
    expect(auditActions()).toEqual([]);
  });

  it("project deletion request: uniq_pending_deletion -> 422 duplicate_deletion_request", async () => {
    failNext(db, "deletion_requests", "insert", raced("uniq_pending_deletion"));
    const json = await expectRule(
      await call(deleteProject, alicePat(), PROJECT, { reason: "cancelled" }, "DELETE"),
      "duplicate_deletion_request",
    );
    expect(json.error).toContain("project");
    expect(auditActions()).toEqual([]);
  });

  it("the pre-check still answers first when the request is already visible", async () => {
    db.rows("deletion_requests").push({ id: "del-1", workspace_id: WS, target_type: "task", target_id: TASK_1, status: "pending" });
    await expectRule(await call(deleteTask, alicePat(), TASK_1, { reason: "obsolete" }, "DELETE"), "duplicate_deletion_request");
  });
});

// ── P2-12: DELETE /resources/:id ───────────────────────────────────────────

describe("P2-12 — DELETE /resources/:id keeps the approval history", () => {
  const sheet = (status: string): Row => ({
    id: `ts-${status}`,
    workspace_id: WS,
    member_id: MEMBER,
    period_start: "2026-10-12",
    period_end: "2026-10-18",
    status,
  });

  it.each(["submitted", "approved", "rejected"])(
    "a member with a %s timesheet is refused (422 has_timesheet_records): nothing is deleted or audited",
    async (status) => {
      db.rows("timesheet_submissions").push(sheet(status));
      await expectRule(await call(deleteResource, alicePat(), MEMBER, undefined, "DELETE"), "has_timesheet_records");
      expect(row("resource_members", MEMBER)).toBeDefined();
      expect(db.rows("time_entries")).toHaveLength(1);
      expect(auditActions()).toEqual([]);
    },
  );

  it("another member's sheet does not block this member", async () => {
    db.rows("timesheet_submissions").push({ ...sheet("approved"), member_id: "99999999-9999-4999-8999-999999999999" });
    const res = await call(deleteResource, alicePat(), MEMBER, undefined, "DELETE");
    expect(res.status).toBe(204);
    expect(db.rows("resource_members").some((m) => m.id === MEMBER)).toBe(false);
    expect(auditActions()).toEqual(["resource.delete"]);
  });

  it("a member with no sheets is deleted as before", async () => {
    expect((await call(deleteResource, alicePat(), MEMBER, undefined, "DELETE")).status).toBe(204);
    expect(auditActions()).toEqual(["resource.delete"]);
  });

  it.each([
    ["P0011", "PERIOD_LOCKED: this week's timesheet is approved and locked", "period_locked"],
    ["P0012", "TIMESHEET_LOCKED: this week's timesheet is submitted", "timesheet_locked"],
  ])("a week-lock trigger error (%s) from the cascade is a 422 %s, not a 500", async (code, message, rule) => {
    failNext(db, "resource_members", "delete", { code, message });
    await expectRule(await call(deleteResource, alicePat(), MEMBER, undefined, "DELETE"), rule);
    expect(auditActions()).toEqual([]);
  });

  it("any other delete error is still a 500", async () => {
    failNext(db, "resource_members", "delete", { code: "XX000", message: "connection reset" });
    expect((await call(deleteResource, alicePat(), MEMBER, undefined, "DELETE")).status).toBe(500);
  });

  it("a member of another workspace is a 404", async () => {
    db.rows("resource_members")[0].workspace_id = "ws-2";
    await expectRule(await call(deleteResource, alicePat(), MEMBER, undefined, "DELETE"), "not_found", 404);
  });
});

// ── budget: every accepted field is persisted; PATCH is truly partial ──────

describe("budget — PUT/PATCH /projects/:id/budget", () => {
  const stored = (): Row => db.rows("project_budget").find((r) => r.project_id === PROJECT) as Row;

  beforeEach(() => {
    db.rows("project_budget").push({
      project_id: PROJECT,
      workspace_id: WS,
      planned_amount: 100,
      committed_amount: 30,
      currency: "EUR",
      actual_amount: 20,
      contingency_reserve: 8,
      management_reserve: 4,
    });
  });

  it("PUT persists actual_amount, contingency_reserve and management_reserve", async () => {
    const res = await call(
      putBudget,
      alicePat(),
      PROJECT,
      { planned_amount: 500, committed_amount: 120, currency: "GBP", actual_amount: 90, contingency_reserve: 25, management_reserve: 10 },
      "PUT",
    );
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({
      planned_amount: 500,
      committed_amount: 120,
      currency: "GBP",
      actual_amount: 90,
      contingency_reserve: 25,
      management_reserve: 10,
    });
    expect((await res.json()).data).toMatchObject({ actual_amount: 90, contingency_reserve: 25, management_reserve: 10 });
  });

  it("PUT that omits the three PMBOK columns leaves them as they were", async () => {
    await call(putBudget, alicePat(), PROJECT, { planned_amount: 500, committed_amount: 120, currency: "GBP" }, "PUT");
    expect(stored()).toMatchObject({ actual_amount: 20, contingency_reserve: 8, management_reserve: 4 });
  });

  it("PATCH of one field changes only that field: committed_amount and currency are NOT reset to their defaults", async () => {
    const res = await call(patchBudget, alicePat(), PROJECT, { planned_amount: 250 }, "PATCH");
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(stored()).toMatchObject({
      planned_amount: 250,
      committed_amount: 30,
      currency: "EUR",
      actual_amount: 20,
      contingency_reserve: 8,
      management_reserve: 4,
    });
  });

  it("PATCH works without planned_amount, and persists the PMBOK columns", async () => {
    const res = await call(patchBudget, alicePat(), PROJECT, { actual_amount: 55, management_reserve: 0 }, "PATCH");
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ planned_amount: 100, committed_amount: 30, currency: "EUR", actual_amount: 55, contingency_reserve: 8, management_reserve: 0 });
  });

  it("PATCH writes an audit row whose before/after show the single change", async () => {
    await call(patchBudget, alicePat(), PROJECT, { committed_amount: 45 }, "PATCH");
    expect(auditActions()).toEqual(["budget.update"]);
    const [audit] = db.rows("audit_log");
    expect(audit.before).toMatchObject({ committed_amount: 30, currency: "EUR" });
    expect(audit.after).toMatchObject({ committed_amount: 45, currency: "EUR" });
  });

  it("PATCH on a project with no budget row creates one holding only what was sent", async () => {
    db.tables.project_budget = [];
    const res = await call(patchBudget, alicePat(), PROJECT, { committed_amount: 7 }, "PATCH");
    expect(res.status).toBe(200);
    expect(db.rows("project_budget")).toHaveLength(1);
    expect(stored()).toMatchObject({ project_id: PROJECT, workspace_id: WS, committed_amount: 7 });
    expect(stored()).not.toHaveProperty("currency");
    expect(stored()).not.toHaveProperty("planned_amount");
  });

  it("PATCH with nothing to change is a 422, not a silent no-op write", async () => {
    for (const body of [{}, { unknown_field: 1 }]) {
      const res = await call(patchBudget, alicePat(), PROJECT, body, "PATCH");
      expect(res.status).toBe(422);
    }
    expect(auditActions()).toEqual([]);
  });

  it("PATCH applies the same per-field rules as PUT", async () => {
    for (const body of [{ planned_amount: -1 }, { committed_amount: "lots" }, { currency: "" }, { actual_amount: -5 }, { management_reserve: null }]) {
      const res = await call(patchBudget, alicePat(), PROJECT, body, "PATCH");
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(stored()).toMatchObject({ planned_amount: 100, committed_amount: 30, currency: "EUR" });
  });

  it("PUT still requires planned_amount", async () => {
    expect((await call(putBudget, alicePat(), PROJECT, { committed_amount: 1 }, "PUT")).status).toBe(422);
  });

  it("a project of another workspace is a 404 for both verbs", async () => {
    db.rows("projects")[0].workspace_id = "ws-2";
    await expectRule(await call(patchBudget, alicePat(), PROJECT, { planned_amount: 1 }, "PATCH"), "not_found", 404);
    await expectRule(await call(putBudget, alicePat(), PROJECT, { planned_amount: 1 }, "PUT"), "not_found", 404);
  });
});

// ── N2: only the member (or an admin / manager) may submit a member's week ──

describe("N2 — submitting a timesheet freezes the week, so it is restricted to the member or a manager", () => {
  const week = { member_id: MEMBER, period_start: "2026-10-12" };
  const sheets = () => db.rows("timesheet_submissions");

  it.each([
    ["the member themselves (a token minted by the person the resource row is linked to)", () => pat("tok-casey", CASEY)],
    ["an admin acting for the member", () => alicePat()],
    ["a manager acting for the member", () => bobPat()],
  ])("%s -> 201", async (_who, actor) => {
    const res = await call(submitTimesheet, actor(), "x", week);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0]).toMatchObject({ member_id: MEMBER, status: "submitted" });
  });

  it.each([
    ["another plain member", () => pat("tok-dana", DANA)],
    ["an admin of a DIFFERENT workspace", () => pat("tok-stranger", STRANGER)],
    ["a principal with no profile at all", () => pat("tok-ghost", "00000000-0000-4000-8000-000000000000")],
  ])("%s -> 403 not_your_timesheet; no sheet, no audit row, the week stays editable", async (_who, actor) => {
    await expectRule(await call(submitTimesheet, actor(), "x", week), "not_your_timesheet", 403);
    expect(sheets()).toHaveLength(0);
    expect(auditActions()).toEqual([]);
  });

  it("a resource row with no linked profile: only an admin / manager can submit for it", async () => {
    await expectRule(
      await call(submitTimesheet, pat("tok-casey", CASEY), "x", { member_id: MEMBER_2, period_start: "2026-10-12" }),
      "not_your_timesheet",
      403,
    );
    // ...whereas the admin gets past the ownership check (and is then refused for lack of entries).
    await expectRule(
      await call(submitTimesheet, alicePat(), "x", { member_id: MEMBER_2, period_start: "2026-10-12" }),
      "nothing_to_submit",
    );
  });
});

// ── P2-2 wiring: a reopened sheet is resubmitted in place, then approved ────

describe("P2-2 — reopen, amend, resubmit, approve", () => {
  beforeEach(() => {
    db.rows("timesheet_submissions").push({
      id: "ts-1",
      workspace_id: WS,
      member_id: MEMBER,
      period_start: "2026-10-12",
      period_end: "2026-10-18",
      hours_total: 8,
      entry_count: 1,
      content_digest: timesheetContentDigest(db.rows("time_entries") as never),
      status: "approved",
      reopened_at: null,
      submitted_by: "tok-casey",
      submitted_by_type: "token",
      submitted_by_label: "tok-casey-agent",
      submitted_principal_id: CASEY,
    });
  });

  async function reopenAndAmend() {
    const reopen = await call(decideTimesheet, bobPat(), "ts-1", { decision: "reopened", rationale: "missed a day" });
    expect(reopen.status, JSON.stringify(await reopen.clone().json())).toBe(200);
    expect(db.rows("timesheet_submissions")[0]).toMatchObject({ status: "submitted" });
    expect(db.rows("timesheet_submissions")[0].reopened_at).toBeTruthy();
    db.rows("time_entries").push({ id: "te-2", workspace_id: WS, member_id: MEMBER, project_id: PROJECT, entry_date: "2026-10-14", hours: 4, billable: true });
  }

  it("without the resubmit the amended sheet is stuck: approval is refused (422 timesheet_changed)", async () => {
    await reopenAndAmend();
    await expectRule(await call(decideTimesheet, bobPat(), "ts-1", { decision: "approved" }), "timesheet_changed");
  });

  it("POST /timesheet-submissions on the reopened week re-snapshots IN PLACE, and the approver can then approve", async () => {
    await reopenAndAmend();

    const res = await call(submitTimesheet, pat("tok-casey", CASEY), "x", { member_id: MEMBER, period_start: "2026-10-12" });
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(201);
    expect(db.rows("timesheet_submissions")).toHaveLength(1);
    expect(json.data).toMatchObject({ id: "ts-1", status: "submitted", entry_count: 2, reopened_at: null, submitted_principal_id: CASEY });
    expect(Number(json.data.hours_total)).toBe(12);

    const approve = await call(decideTimesheet, bobPat(), "ts-1", { decision: "approved" });
    const body = await approve.json();
    expect(approve.status, JSON.stringify(body)).toBe(200);
    expect(body.code).toBeUndefined();
    expect(db.rows("timesheet_submissions")[0]).toMatchObject({ status: "approved" });
  });

  it("only the member (or a manager) can resubmit: another member is refused and the sheet is untouched", async () => {
    await reopenAndAmend();
    await expectRule(
      await call(submitTimesheet, pat("tok-dana", DANA), "x", { member_id: MEMBER, period_start: "2026-10-12" }),
      "not_your_timesheet",
      403,
    );
    expect(db.rows("timesheet_submissions")[0]).toMatchObject({ entry_count: 1, hours_total: 8 });
    expect(db.rows("timesheet_submissions")[0].reopened_at).toBeTruthy();
  });

  it("a sheet that is NOT reopened is still the duplicate 422 (approved, or submitted and awaiting review)", async () => {
    await expectRule(
      await call(submitTimesheet, pat("tok-casey", CASEY), "x", { member_id: MEMBER, period_start: "2026-10-12" }),
      "duplicate_submission",
    );
    Object.assign(db.rows("timesheet_submissions")[0], { status: "submitted", reopened_at: null });
    await expectRule(
      await call(submitTimesheet, pat("tok-casey", CASEY), "x", { member_id: MEMBER, period_start: "2026-10-12" }),
      "duplicate_submission",
    );
  });
});

// ── a project is never created locked ───────────────────────────────────────

describe("POST /projects never creates a locked project", () => {
  const createdRow = () => db.rows("projects").find((p) => p.code === "NEW1") as Row;

  it("is_locked (and locked_at / locked_by) in the body are stripped: the project is born open", async () => {
    const res = await call(createProject, alicePat(), "x", {
      code: "NEW1",
      name: "Born locked?",
      is_locked: true,
      locked_at: "2026-10-01T00:00:00.000Z",
      locked_by: ALICE,
      lock_reason: "sneaky",
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect(createdRow()).toMatchObject({ code: "NEW1", name: "Born locked?", workspace_id: WS });
    for (const column of ["is_locked", "locked_at", "locked_by", "lock_reason"]) {
      expect(createdRow(), column).not.toHaveProperty(column);
    }
    expect((db.rows("audit_log")[0].after as Row).is_locked).not.toBe(true);
  });

  it("is_locked: false is stripped too, and an ordinary create is unchanged", async () => {
    const res = await call(createProject, alicePat(), "x", { code: "NEW1", name: "Plain", is_locked: false, description: "kept" });
    expect(res.status).toBe(201);
    expect(createdRow()).toMatchObject({ name: "Plain", description: "kept" });
    expect(createdRow()).not.toHaveProperty("is_locked");
  });

  it("the new project is locked only by the lock route (which snapshots its baselines)", async () => {
    await call(createProject, alicePat(), "x", { code: "NEW1", name: "Plain", is_locked: true });
    const id = String(createdRow().id);
    createdRow().is_locked = false; // the column default
    simulateLockBackstop(db);
    expect((await call(lockProject, alicePat(), id)).status).toBe(200);
    expect(createdRow().is_locked).toBe(true);
  });
});
