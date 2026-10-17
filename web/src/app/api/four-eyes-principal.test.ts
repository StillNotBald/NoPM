/**
 * Principal-aware four-eyes at the HTTP edge (2026-10-16, D1/D2).
 *
 * Drives the real route handlers (wrapped by route()) with an in-memory
 * admin client, for all four governed kinds — deletion request, change
 * request, timesheet submission, rebaseline sign-off:
 *
 *   - "requester approves own request with own PAT" -> 403  (the headline bug:
 *     a person raised a request in the console and approved it with a PAT they
 *     minted, because four-eyes compared actor ids, not humans);
 *   - a token with no recorded owner can't decide -> 403 NO_PRINCIPAL;
 *   - wildcard scopes (`*`, `<resource>:*`) never grant approve/decide;
 *   - every request-creation insert stamps the requester's PRINCIPAL and emits
 *     a fully populated event to the Integration Hub;
 *   - the decision routes are thin wrappers (one audit row, one event).
 *
 * requireAuth is mocked (guard.test.ts / guard-principal.test.ts cover token
 * and session resolution); requireScope is the REAL one, so scope behaviour
 * (including D2) is exercised for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

const { holder, emitted, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  emitted: { requested: [] as unknown[], decided: [] as unknown[] },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: (ev: unknown) => void emitted.requested.push(ev),
  emitApprovalDecided: (ev: unknown) => void emitted.decided.push(ev),
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

import { POST as approveDeletion } from "./deletion-requests/[id]/approve/route";
import { POST as rejectDeletion } from "./deletion-requests/[id]/reject/route";
import { POST as decideChange } from "./change-requests/[id]/decision/route";
import { POST as decideTimesheet } from "./timesheet-submissions/[id]/decision/route";
import { POST as signoff } from "./rebaselines/[id]/signoff/route";
import { POST as applyRebaseline } from "./rebaselines/[id]/apply/route";
import { DELETE as deleteTask } from "./tasks/[id]/route";
import { DELETE as deleteProject } from "./projects/[id]/route";
import { POST as raiseChange } from "./projects/[id]/change-requests/route";
import { POST as submitTimesheet } from "./timesheet-submissions/route";
import { POST as raiseRebaseline } from "./projects/[id]/rebaselines/route";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";

const ALL_APPROVE = [
  "task:delete:approve",
  "project:delete:approve",
  "change:decide",
  "time:approve",
  "rebaseline:approve",
];

function session(id: string, over: Partial<Actor> = {}): Actor {
  return {
    type: "user",
    id,
    label: id === ALICE ? "Alice" : "Bob",
    workspaceId: WS,
    role: "admin",
    principalId: id,
    channel: "ui",
    requestId: `req-${id}`,
    ...over,
  };
}

function pat(id: string, owner: string | null, scopes: string[]): Actor {
  return {
    type: "token",
    id,
    tokenId: id,
    label: `${id}-agent`,
    workspaceId: WS,
    scopes,
    principalId: owner,
    principalRole: owner ? "manager" : null,
    channel: "api",
    requestId: `req-${id}`,
  };
}

/** Alice's own PAT with every checker scope — the bypass attempt. */
const aliceOwnPat = () => pat("tok-alice", ALICE, ALL_APPROVE);
const bobPat = () => pat("tok-bob", BOB, ALL_APPROVE);
const orphanPat = () => pat("tok-orphan", null, ALL_APPROVE);

let db: FakeDb;

function seed(): FakeDb {
  return new FakeDb({
    projects: [{ id: "proj-1", workspace_id: WS, name: "Billing Migration", is_locked: false }],
    tasks: [{ id: "task-1", workspace_id: WS, name: "Migrate billing DB", project_id: "proj-1" }],
    resource_members: [{ id: MEMBER, workspace_id: WS, name: "Casey Member" }],
    time_entries: [
      { id: "te-1", workspace_id: WS, member_id: MEMBER, entry_date: "2026-10-13", hours: 8 },
      { id: "te-2", workspace_id: WS, member_id: MEMBER, entry_date: "2026-10-14", hours: 6.5 },
    ],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "admin" },
      { id: BOB, workspace_id: WS, role: "manager" },
    ],
    // Alice raised each request in the console (a session) — so Alice is the maker.
    deletion_requests: [
      {
        id: "del-1",
        workspace_id: WS,
        target_type: "task",
        target_id: "task-1",
        status: "pending",
        reason: "duplicate",
        requested_by_type: "user",
        requested_by_id: ALICE,
        requested_by_label: "Alice",
        requested_principal_id: ALICE,
        before: { id: "task-1", name: "Migrate billing DB", project_id: "proj-1" },
      },
    ],
    change_requests: [
      {
        id: "cr-1",
        workspace_id: WS,
        project_id: "proj-1",
        reference_id: "CR-001",
        title: "Extend go-live",
        status: "raised",
        requested_by: ALICE,
        requested_by_type: "user",
        requested_by_id: ALICE,
        requested_by_label: "Alice",
        requested_principal_id: ALICE,
      },
    ],
    timesheet_submissions: [
      {
        id: "ts-1",
        workspace_id: WS,
        member_id: MEMBER,
        period_start: "2026-10-12",
        period_end: "2026-10-18",
        hours_total: 14.5,
        entry_count: 2,
        status: "submitted",
        submitted_by: ALICE,
        submitted_by_type: "user",
        submitted_by_label: "Alice",
        submitted_principal_id: ALICE,
      },
    ],
    rebaselines: [
      {
        id: "rb-user",
        workspace_id: WS,
        project_id: "proj-1",
        version: 1,
        status: "pending_approval",
        requested_by: ALICE,
        requested_principal_id: ALICE,
      },
      {
        // Raised through Alice's PAT: the legacy requested_by is user-only, so it is NULL.
        id: "rb-token",
        workspace_id: WS,
        project_id: "proj-1",
        version: 2,
        status: "pending_approval",
        requested_by: null,
        requested_principal_id: ALICE,
      },
      {
        id: "rb-approved",
        workspace_id: WS,
        project_id: "proj-1",
        version: 3,
        status: "approved",
        requested_by: null,
        requested_principal_id: ALICE,
      },
    ],
    rebaseline_signoffs: [],
    audit_log: [],
    notifications: [],
  });
}

function call(
  handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  actor: Actor,
  id: string,
  body?: unknown,
  method = "POST",
) {
  authHolder.actor = actor;
  const req = new NextRequest(`http://localhost/api/x/${id}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handler(req, { params: Promise.resolve({ id }) });
}

const callCollection = (
  handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  actor: Actor,
  body: unknown,
  id = "proj-1",
) => call(handler, actor, id, body);

async function expectForbidden(res: Response, code: string, messagePart?: string) {
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(403);
  expect(json.code).toBe(code);
  if (messagePart) expect(json.error).toContain(messagePart);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  db = seed();
  holder.db = db;
  emitted.requested.length = 0;
  emitted.decided.length = 0;
  db.rpcHandlers.nopm_apply_rebaseline_snapshot = () => ({ data: null, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── headline regression: requester + own PAT -> 403, for all four kinds ───

describe("requester approves own request with own PAT -> 403 (all four kinds)", () => {
  it("deletion request: approve", async () => {
    const res = await call(approveDeletion, aliceOwnPat(), "del-1", {});
    await expectForbidden(res, "self_approval", "Self-approval is not allowed");
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
    expect(db.rows("tasks")).toHaveLength(1);
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("deletion request: reject", async () => {
    const res = await call(rejectDeletion, aliceOwnPat(), "del-1", { reason: "x" });
    await expectForbidden(res, "self_approval");
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
  });

  it("change request: decision", async () => {
    const res = await call(decideChange, aliceOwnPat(), "cr-1", { decision: "approve", rationale: "fine" });
    await expectForbidden(res, "self_approval");
    expect(db.rows("change_requests")[0].status).toBe("raised");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("timesheet submission: decision", async () => {
    const res = await call(decideTimesheet, aliceOwnPat(), "ts-1", { decision: "approved" });
    await expectForbidden(res, "self_approval");
    expect(db.rows("timesheet_submissions")[0].status).toBe("submitted");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("rebaseline: sign-off (user-raised and token-raised)", async () => {
    for (const id of ["rb-user", "rb-token"]) {
      const res = await call(signoff, aliceOwnPat(), id, { vote: "go" });
      await expectForbidden(res, "self_approval");
    }
    expect(db.rows("rebaseline_signoffs")).toHaveLength(0);
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("rebaseline: apply", async () => {
    const res = await call(applyRebaseline, aliceOwnPat(), "rb-approved", {});
    await expectForbidden(res, "self_approval");
    expect(db.rows("rebaselines").find((r) => r.id === "rb-approved")?.status).toBe("approved");
  });

  it("the reverse also holds: raised through the PAT, decided from the owner's session", async () => {
    db.tables.change_requests = [
      {
        ...db.rows("change_requests")[0],
        requested_by: null,
        requested_by_type: "token",
        requested_by_id: "tok-alice",
        requested_principal_id: ALICE,
      },
    ];
    const res = await call(decideChange, session(ALICE), "cr-1", { decision: "approve", rationale: "fine" });
    await expectForbidden(res, "self_approval");
  });
});

// ── a different human still gets through ──────────────────────────────────

describe("a different human decides (the happy paths still work)", () => {
  it("deletion: approve with a note -> 200 { committed: true }; the note lands in the audit row; one event", async () => {
    const res = await call(approveDeletion, bobPat(), "del-1", { note: "confirmed with the owner" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { committed: true } });

    const governance = db.rows("audit_log").filter((r) => r.action === "deletion_request.approved");
    expect(governance).toHaveLength(1);
    expect(governance[0].after).toEqual({
      status: "committed",
      approver_principal_id: BOB,
      note: "confirmed with the owner",
    });
    expect(db.rows("tasks")).toHaveLength(0);
    expect(emitted.decided).toHaveLength(1);
    expect(emitted.decided[0]).toMatchObject({ kind: "task_deletion", status: "committed", channel: "api" });
  });

  it("deletion: approve with NO body at all (the CLI sends none) still works", async () => {
    const res = await call(approveDeletion, session(BOB), "del-1");
    expect(res.status).toBe(200);
  });

  it("deletion: reject -> 200 { rejected: true }", async () => {
    const res = await call(rejectDeletion, bobPat(), "del-1", { reason: "still needed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { rejected: true } });
    expect(db.rows("audit_log").map((r) => r.action)).toEqual(["deletion_request.rejected"]);
  });

  it("change request: decision echoes the updated row", async () => {
    const res = await call(decideChange, bobPat(), "cr-1", { decision: "approve", rationale: "sponsor agreed" });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ id: "cr-1", status: "approved", decided_principal_id: BOB });
    expect(db.rows("audit_log").map((r) => r.action)).toEqual(["change_request.decide"]);
  });

  it("change request: a missing rationale is still a 422 validation error", async () => {
    const res = await call(decideChange, bobPat(), "cr-1", { decision: "approve" });
    expect(res.status).toBe(422);
  });

  it("timesheet: decision echoes the updated row", async () => {
    const res = await call(decideTimesheet, bobPat(), "ts-1", { decision: "approved" });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ id: "ts-1", status: "approved", decided_principal_id: BOB });
    expect(db.rows("audit_log").map((r) => r.action)).toEqual(["timesheet.approved"]);
  });

  it("rebaseline: a token signs off AS ITS OWNER (approver_id = the principal, a real profile — no FK 500)", async () => {
    const res = await call(signoff, bobPat(), "rb-user", { vote: "go", comment: "lgtm" });
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(200);
    const [vote] = db.rows("rebaseline_signoffs");
    expect(vote).toMatchObject({ approver_id: BOB, approver_principal_id: BOB, vote: "go" });
    expect(json.data.rebaseline.status).toBe("approved");
    expect(db.rows("audit_log")).toHaveLength(1);
    expect(db.rows("audit_log")[0]).toMatchObject({ action: "rebaseline.signoff", actor_type: "token", actor_id: "tok-bob" });
  });

  it("rebaseline: a person has one vote however many identities they use (session then PAT update the same row)", async () => {
    // Another approver's vote is still outstanding, so Bob's first vote does not decide the
    // rebaseline (a decided rebaseline takes no more votes, R1/M2).
    db.tables.rebaseline_signoffs = [
      { id: "so-other", workspace_id: WS, rebaseline_id: "rb-user", approver_id: "someone-else", vote: "pending" },
    ];
    await call(signoff, session(BOB), "rb-user", { vote: "go" });
    await call(signoff, bobPat(), "rb-user", { vote: "no_go" });
    const bobVotes = db.rows("rebaseline_signoffs").filter((r) => r.approver_id === BOB);
    expect(bobVotes).toHaveLength(1);
    expect(bobVotes[0].vote).toBe("no_go");
  });

  it("rebaseline: apply by a different human", async () => {
    db.rows("projects")[0].is_locked = true; // a sign-off is for a locked project
    const res = await call(applyRebaseline, bobPat(), "rb-approved", {});
    expect(res.status).toBe(200);
    expect(db.rows("rebaselines").find((r) => r.id === "rb-approved")?.status).toBe("applied");
  });
});

// ── fail-closed: no principal, no decision ────────────────────────────────

describe("a token with no recorded owner cannot decide (403 NO_PRINCIPAL)", () => {
  const MESSAGE = "This token has no recorded owner, so it cannot approve (four-eyes)";

  it("on every decision route", async () => {
    await expectForbidden(await call(approveDeletion, orphanPat(), "del-1", {}), "no_principal", MESSAGE);
    await expectForbidden(await call(rejectDeletion, orphanPat(), "del-1", {}), "no_principal", MESSAGE);
    await expectForbidden(
      await call(decideChange, orphanPat(), "cr-1", { decision: "approve", rationale: "x" }),
      "no_principal",
      MESSAGE,
    );
    await expectForbidden(await call(decideTimesheet, orphanPat(), "ts-1", { decision: "approved" }), "no_principal", MESSAGE);
    await expectForbidden(await call(signoff, orphanPat(), "rb-user", { vote: "go" }), "no_principal", MESSAGE);
    await expectForbidden(await call(applyRebaseline, orphanPat(), "rb-approved", {}), "no_principal", MESSAGE);
    expect(db.rows("audit_log")).toHaveLength(0);
    expect(db.rows("rebaseline_signoffs")).toHaveLength(0);
    expect(db.rpcCallsTo("nopm_commit_task_deletion")).toHaveLength(0);
  });
});

// ── D2: wildcards never grant approve/decide ──────────────────────────────

describe("wildcard scopes never grant approve/decide (D2)", () => {
  for (const wildcard of [["*"], ["task:*", "change:*", "time:*", "rebaseline:*", "project:*"]]) {
    it(`token holding ${JSON.stringify(wildcard)} is refused on every decision route`, async () => {
      const t = pat("tok-bob", BOB, wildcard);
      await expectForbidden(await call(approveDeletion, t, "del-1", {}), "forbidden_scope", "task:delete:approve");
      await expectForbidden(await call(rejectDeletion, t, "del-1", {}), "forbidden_scope", "task:delete:approve");
      await expectForbidden(
        await call(decideChange, t, "cr-1", { decision: "approve", rationale: "x" }),
        "forbidden_scope",
        "change:decide",
      );
      await expectForbidden(await call(decideTimesheet, t, "ts-1", { decision: "approved" }), "forbidden_scope", "time:approve");
      await expectForbidden(await call(signoff, t, "rb-user", { vote: "go" }), "forbidden_scope", "rebaseline:approve");
      await expectForbidden(await call(applyRebaseline, t, "rb-approved", {}), "forbidden_scope", "rebaseline:approve");
      expect(db.rows("audit_log")).toHaveLength(0);
    });
  }
});

// ── creation points stamp the requester PRINCIPAL and emit a full event ────

describe("every request-creation insert records the requester's principal and emits an event", () => {
  const aliceRaisesViaPat = () => pat("tok-alice", ALICE, ["task:delete:request", "project:delete:request", "change:write", "time:submit", "project:write"]);

  it("task deletion request (PAT): principal = the token's creator, not the token id", async () => {
    db.tables.deletion_requests = [];
    const res = await call(deleteTask, aliceRaisesViaPat(), "task-1", { reason: "obsolete" }, "DELETE");
    expect(res.status).toBe(202);
    const row = db.rows("deletion_requests")[0];
    expect(row).toMatchObject({
      requested_by_type: "token",
      requested_by_id: "tok-alice",
      requested_principal_id: ALICE,
    });
    expect(emitted.requested).toEqual([
      {
        workspaceId: WS,
        kind: "task_deletion",
        id: row.id,
        title: 'Delete task "Migrate billing DB"',
        summary: "obsolete",
        projectId: "proj-1",
        projectName: "Billing Migration",
        requestedByLabel: "tok-alice-agent (token)",
        requesterPrincipalId: ALICE,
      },
    ]);
    // ...and Alice's own PAT can then NOT approve it (the end-to-end bypass).
    const bypass = await call(approveDeletion, aliceOwnPat(), String(row.id), {});
    await expectForbidden(bypass, "self_approval");
  });

  it("task deletion request (session): principal = the user", async () => {
    db.tables.deletion_requests = [];
    await call(deleteTask, session(ALICE), "task-1", { reason: "obsolete" }, "DELETE");
    expect(db.rows("deletion_requests")[0]).toMatchObject({ requested_by_type: "user", requested_principal_id: ALICE });
    expect((emitted.requested[0] as { requestedByLabel: string }).requestedByLabel).toBe("Alice");
  });

  it("a token with no recorded creator can NOT raise a task deletion request (403 no_principal, R1/H3) — nothing is queued or announced", async () => {
    db.tables.deletion_requests = [];
    const auditBefore = db.rows("audit_log").length;
    const res = await call(deleteTask, pat("tok-orphan", null, ["task:delete:request"]), "task-1", { reason: "x" }, "DELETE");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("no_principal");
    expect(db.rows("deletion_requests")).toHaveLength(0);
    expect(db.rows("audit_log")).toHaveLength(auditBefore);
    expect(emitted.requested).toHaveLength(0);
  });

  it("project deletion request", async () => {
    db.tables.deletion_requests = [];
    const res = await call(deleteProject, aliceRaisesViaPat(), "proj-1", { reason: "cancelled" }, "DELETE");
    expect(res.status).toBe(202);
    const row = db.rows("deletion_requests")[0];
    expect(row).toMatchObject({ target_type: "project", requested_principal_id: ALICE });
    expect(emitted.requested[0]).toMatchObject({
      kind: "project_deletion",
      id: row.id,
      title: 'Delete project "Billing Migration"',
      projectId: "proj-1",
      projectName: "Billing Migration",
      requesterPrincipalId: ALICE,
    });
  });

  it("project deletion request: a LOCKED project is refused at REQUEST time (422 project_locked), audited as blocked, nothing queued", async () => {
    db.tables.deletion_requests = [];
    db.rows("projects")[0].is_locked = true;
    const res = await call(deleteProject, aliceRaisesViaPat(), "proj-1", { reason: "cancelled" }, "DELETE");
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(422);
    expect(json.code).toBe("project_locked");
    expect(json.error).toContain("locked");
    expect(db.rows("deletion_requests")).toHaveLength(0);
    expect(emitted.requested).toHaveLength(0);
    expect(db.rows("audit_log")).toHaveLength(1);
    expect(db.rows("audit_log")[0]).toMatchObject({
      action: "project.delete_request.blocked",
      target_type: "project",
      target_id: "proj-1",
      after: { reason: "project_locked", project_id: "proj-1" },
    });
  });

  it("the commit-time backstop still holds: locked AFTER the request was raised -> approve is a 422 and the project survives", async () => {
    db.tables.deletion_requests = [
      {
        id: "del-p",
        workspace_id: WS,
        target_type: "project",
        target_id: "proj-1",
        status: "pending",
        requested_by_type: "user",
        requested_by_id: ALICE,
        requested_by_label: "Alice",
        requested_principal_id: ALICE,
        before: { id: "proj-1", name: "Billing Migration" },
      },
    ];
    db.rows("projects")[0].is_locked = true;
    const res = await call(approveDeletion, bobPat(), "del-p", {});
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("Project is locked");
    expect(db.rows("projects")).toHaveLength(1);
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
  });

  it("change request", async () => {
    db.tables.change_requests = [];
    const res = await callCollection(raiseChange, aliceRaisesViaPat(), { title: "Add APAC module", impact_summary: "+8 weeks" });
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(201);
    const row = db.rows("change_requests")[0];
    expect(row).toMatchObject({ requested_by_type: "token", requested_by_id: "tok-alice", requested_principal_id: ALICE, status: "raised" });
    expect(emitted.requested[0]).toMatchObject({
      kind: "change_request",
      id: row.id,
      title: "Change request CR-001: Add APAC module",
      summary: "+8 weeks",
      projectId: "proj-1",
      projectName: "Billing Migration",
      requestedByLabel: "tok-alice-agent (token)",
      requesterPrincipalId: ALICE,
    });
  });

  it("change request: only raise-time statuses are accepted — a terminal status is a clean 422, not a raw DB error (UC-10)", async () => {
    for (const status of ["approved", "rejected", "deferred", "implemented", "bogus"]) {
      const res = await callCollection(raiseChange, aliceRaisesViaPat(), { title: "Sneaky", status });
      const json = await res.json();
      expect(res.status, status).toBe(422);
      expect(json.fields.map((f: { field: string }) => f.field)).toContain("status");
    }
    expect(db.rows("change_requests")).toHaveLength(1); // only the seeded one
    expect(emitted.requested).toHaveLength(0);

    const ok = await callCollection(raiseChange, aliceRaisesViaPat(), { title: "Under review", status: "under_review" });
    expect(ok.status).toBe(201);
  });

  it("timesheet submission", async () => {
    db.tables.timesheet_submissions = [];
    const res = await call(
      submitTimesheet,
      aliceRaisesViaPat(),
      "x",
      { member_id: MEMBER, period_start: "2026-10-12" },
    );
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(201);
    const row = db.rows("timesheet_submissions")[0];
    expect(row).toMatchObject({ submitted_by: "tok-alice", submitted_by_type: "token", submitted_principal_id: ALICE, status: "submitted" });
    expect(emitted.requested[0]).toMatchObject({
      kind: "timesheet",
      id: row.id,
      title: "Timesheet: Casey Member, week of 2026-10-12",
      summary: "14.5 hours across 2 entries.",
      requestedByLabel: "tok-alice-agent (token)",
      requesterPrincipalId: ALICE,
    });
  });

  it("rebaseline", async () => {
    db.tables.rebaselines = [];
    const res = await callCollection(raiseRebaseline, aliceRaisesViaPat(), { reason: "dates slipped" });
    expect(res.status).toBe(201);
    expect(db.rows("rebaselines")[0]).toMatchObject({ requested_by: null, requested_principal_id: ALICE });
  });

  it("notifications still go to the maker's human (a profile), not a token id", async () => {
    db.tables.deletion_requests = [];
    await call(deleteTask, aliceRaisesViaPat(), "task-1", { reason: "obsolete" }, "DELETE");
    await flush();
    const recipients = db.rows("notifications").map((n) => n.recipient_id);
    expect(recipients.sort()).toEqual([ALICE, BOB].sort());
  });
});

// ── D-16: approving is for admins and managers only, on every channel ─────

describe("D-16 — a member or viewer (or their token) cannot approve anything", () => {
  const memberSession = (): Actor => ({ ...session(BOB), role: "member" });
  const memberPat = (): Actor => ({ ...bobPat(), principalRole: "member" }) as Actor;
  const viewerPat = (): Actor => ({ ...bobPat(), principalRole: "viewer" }) as Actor;

  it("403 role_not_permitted on every approve / decide verb, nothing recorded", async () => {
    for (const actor of [memberPat(), viewerPat()]) {
      await expectForbidden(await call(approveDeletion, actor, "del-1", {}), "role_not_permitted", "Only managers and admins can approve");
      await expectForbidden(await call(rejectDeletion, actor, "del-1", {}), "role_not_permitted", "Only managers and admins can approve");
      await expectForbidden(
        await call(decideChange, actor, "cr-1", { decision: "approve", rationale: "x" }),
        "role_not_permitted",
        "Only managers and admins can approve",
      );
      await expectForbidden(await call(decideTimesheet, actor, "ts-1", { decision: "approved" }), "role_not_permitted", "Only managers and admins can approve");
      await expectForbidden(await call(signoff, actor, "rb-user", { vote: "go" }), "role_not_permitted", "Only managers and admins can approve");
      await expectForbidden(await call(applyRebaseline, actor, "rb-approved", {}), "role_not_permitted", "Only managers and admins can approve");
    }
    await expectForbidden(await call(approveDeletion, memberSession(), "del-1", {}), "role_not_permitted", "Only managers and admins can approve");
    expect(db.rows("audit_log")).toHaveLength(0);
    expect(db.rpcCallsTo("nopm_commit_task_deletion")).toHaveLength(0);
  });
});
