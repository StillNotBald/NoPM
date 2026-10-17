/**
 * Governed-lifecycle guards at the HTTP edge (red-team R1: H1, H3, M2-M4).
 *
 * Drives the real route handlers (wrapped by route()) with an in-memory admin
 * client, one describe block per finding. The database twins of these rules
 * (migration 0049) are covered by lifecycle-guards-migration.test.ts and the
 * local-DB probes; here the API layer must already refuse the move with a clean
 * 4xx and leave the data untouched.
 *
 * requireAuth is mocked (guard.test.ts covers token and session resolution);
 * requireScope is the REAL one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb, type Row } from "@/lib/governance/test-support/fake-admin";

const { holder, emitted, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  emitted: { requested: [] as unknown[], decided: [] as unknown[], changed: [] as unknown[] },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: (ev: unknown) => void emitted.requested.push(ev),
  emitApprovalDecided: (ev: unknown) => void emitted.decided.push(ev),
  emitApprovalChanged: (ev: unknown) => void emitted.changed.push(ev),
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

import { PATCH as patchProject, DELETE as deleteProject } from "./projects/[id]/route";
import { POST as createProject } from "./projects/route";
import { POST as raiseChange } from "./projects/[id]/change-requests/route";
import { PATCH as patchChange, DELETE as deleteChange } from "./change-requests/[id]/route";
import { POST as raiseRebaseline } from "./projects/[id]/rebaselines/route";
import { POST as signoff } from "./rebaselines/[id]/signoff/route";
import { POST as applyRebaseline } from "./rebaselines/[id]/apply/route";
import { POST as approveDeletion } from "./deletion-requests/[id]/approve/route";
import { POST as decideChange } from "./change-requests/[id]/decision/route";

const WS = "ws-1";
const OTHER_WS = "ws-2";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const STRANGER = "99999999-9999-4999-8999-999999999999"; // a profile in ANOTHER workspace
const MEMBER = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";

const SCOPES = [
  "project:read",
  "project:write",
  "project:delete:request",
  "project:delete:approve",
  "change:write",
  "change:decide",
  "rebaseline:approve",
];

function session(id: string): Actor {
  return {
    type: "user",
    id,
    label: id === ALICE ? "Alice" : "Bob",
    workspaceId: WS,
    role: "admin",
    principalId: id,
    channel: "ui",
    requestId: `req-${id}`,
  };
}

function pat(id: string, owner: string | null, scopes: string[] = SCOPES): Actor {
  return {
    type: "token",
    id,
    tokenId: id,
    label: `${id}-agent`,
    workspaceId: WS,
    scopes,
    principalId: owner,
    // The human behind these test tokens is an admin.
    principalRole: "admin",
    channel: "api",
    requestId: `req-${id}`,
  };
}

const alicePat = () => pat("tok-alice", ALICE);
const bobPat = () => pat("tok-bob", BOB);
/** A legacy token with no recorded owner. */
const orphanPat = () => pat("tok-orphan", null);

let db: FakeDb;

function seed(): FakeDb {
  return new FakeDb({
    projects: [
      {
        id: PROJECT,
        workspace_id: WS,
        name: "Billing Migration",
        is_locked: false,
        default_billable: true,
        start_date: "2027-01-01",
        target_date: "2027-06-30",
        baseline_start_date: "2027-01-01",
        baseline_target_date: "2027-06-30",
        updated_at: "2026-10-01T00:00:00.000Z",
      },
    ],
    tasks: [{ id: "task-1", workspace_id: WS, name: "Migrate billing DB", project_id: PROJECT }],
    resource_members: [{ id: MEMBER, workspace_id: WS, name: "Casey Member", cost_rate: 10, profile_id: null }],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "admin" },
      { id: BOB, workspace_id: WS, role: "manager" },
      { id: STRANGER, workspace_id: OTHER_WS, role: "admin" },
    ],
    change_requests: [
      {
        id: "cr-1",
        workspace_id: WS,
        project_id: PROJECT,
        reference_id: "CR-001",
        title: "Extend go-live",
        impact_cost: 1000,
        updated_at: "2026-10-16T09:00:00.000Z",
        status: "raised",
        requested_by: ALICE,
        requested_by_type: "user",
        requested_by_id: ALICE,
        requested_by_label: "Alice",
        requested_principal_id: ALICE,
      },
    ],
    rebaselines: [
      { id: "rb-pending", workspace_id: WS, project_id: PROJECT, version: 1, status: "pending_approval", requested_by: ALICE, requested_principal_id: ALICE },
      { id: "rb-rejected", workspace_id: WS, project_id: PROJECT, version: 2, status: "rejected", requested_by: ALICE, requested_principal_id: ALICE },
      { id: "rb-approved", workspace_id: WS, project_id: PROJECT, version: 3, status: "approved", requested_by: ALICE, requested_principal_id: ALICE },
      { id: "rb-applied", workspace_id: WS, project_id: PROJECT, version: 4, status: "applied", requested_by: ALICE, requested_principal_id: ALICE },
      { id: "rb-draft", workspace_id: WS, project_id: PROJECT, version: 5, status: "draft", requested_by: ALICE, requested_principal_id: ALICE },
    ],
    rebaseline_signoffs: [],
    deletion_requests: [],
    audit_log: [],
    notifications: [],
  });
}

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

const project = () => db.rows("projects")[0];
const auditActions = () => db.rows("audit_log").map((r) => r.action);

beforeEach(() => {
  db = seed();
  holder.db = db;
  emitted.requested.length = 0;
  emitted.decided.length = 0;
  emitted.changed.length = 0;
  db.rpcHandlers.nopm_apply_rebaseline_snapshot = () => ({ data: null, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── H1: a locked project's baseline cannot be rewritten ───────────────────

describe("H1 — locked project baseline", () => {
  beforeEach(() => {
    project().is_locked = true;
  });

  it("PATCH of the baseline dates / schedule dates is a 422 project_locked, the row is untouched, the attempt is audited", async () => {
    const res = await call(
      patchProject,
      alicePat(),
      PROJECT,
      { baseline_target_date: "2029-01-01", baseline_start_date: "2028-01-01", target_date: "2029-01-01" },
      "PATCH",
    );
    const json = await expectRule(res, "project_locked");
    expect(json.error).toContain("locked");
    expect(project()).toMatchObject({
      baseline_start_date: "2027-01-01",
      baseline_target_date: "2027-06-30",
      target_date: "2027-06-30",
    });
    expect(auditActions()).toEqual(["project.update.blocked"]);
    expect(db.rows("audit_log")[0].after).toMatchObject({
      reason: "project_locked",
      fields: expect.arrayContaining(["baseline_target_date", "baseline_start_date", "target_date"]),
    });
  });

  it("each of the four schedule fields is guarded on its own", async () => {
    for (const field of ["start_date", "target_date", "baseline_start_date", "baseline_target_date"]) {
      const res = await call(patchProject, alicePat(), PROJECT, { [field]: "2030-05-05" }, "PATCH");
      await expectRule(res, "project_locked");
    }
    expect(project().start_date).toBe("2027-01-01");
  });

  it("day-to-day edits stay live under a lock: name, RAG, commentary", async () => {
    const res = await call(patchProject, alicePat(), PROJECT, { name: "Billing Migration v2", rag_status: "amber" }, "PATCH");
    expect(res.status).toBe(200);
    expect(project()).toMatchObject({ name: "Billing Migration v2", rag_status: "amber" });
    expect(auditActions()).toEqual(["project.update"]);
  });

  it("a form that echoes the stored dates back is not a change", async () => {
    const res = await call(
      patchProject,
      alicePat(),
      PROJECT,
      { name: "Renamed", start_date: "2027-01-01", target_date: "2027-06-30", baseline_target_date: "2027-06-30T00:00:00Z" },
      "PATCH",
    );
    expect(res.status).toBe(200);
  });

  it("once unlocked the dates move freely again", async () => {
    project().is_locked = false;
    const res = await call(patchProject, alicePat(), PROJECT, { target_date: "2027-09-30" }, "PATCH");
    expect(res.status).toBe(200);
    expect(project().target_date).toBe("2027-09-30");
  });
});

describe("H1 — owner_id must belong to the caller's workspace", () => {
  it("PATCH with another workspace's profile is a 422 invalid_reference and nothing is written", async () => {
    const res = await call(patchProject, alicePat(), PROJECT, { owner_id: STRANGER }, "PATCH");
    const json = await expectRule(res, "invalid_reference");
    expect(json.fields).toEqual([{ field: "owner_id", message: "owner_id was not found in this workspace" }]);
    expect(project().owner_id).toBeUndefined();
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("PATCH with a profile of this workspace works", async () => {
    const res = await call(patchProject, alicePat(), PROJECT, { owner_id: BOB }, "PATCH");
    expect(res.status).toBe(200);
    expect(project().owner_id).toBe(BOB);
  });

  it("POST /projects refuses a foreign owner_id too, and accepts a local one", async () => {
    const base = { code: "NEW1", name: "New project" };
    await expectRule(await call(createProject, alicePat(), "x", { ...base, owner_id: STRANGER }), "invalid_reference");
    expect(db.rows("projects")).toHaveLength(1);

    const res = await call(createProject, alicePat(), "x", { ...base, owner_id: BOB });
    expect(res.status).toBe(201);
    expect(db.rows("projects")).toHaveLength(2);
  });
});

// ── H3: an ownerless token cannot RAISE a governed request ────────────────

describe("H3 — a token with no recorded owner cannot raise a governed request", () => {
  async function expectNoPrincipal(res: Response) {
    const json = await expectRule(res, "no_principal", 403);
    expect(json.error).toContain("no recorded owner");
  }

  it("project deletion request", async () => {
    await expectNoPrincipal(await call(deleteProject, orphanPat(), PROJECT, { reason: "cancelled" }, "DELETE"));
    expect(db.rows("deletion_requests")).toHaveLength(0);
  });

  it("change request raise", async () => {
    await expectNoPrincipal(await call(raiseChange, orphanPat(), PROJECT, { title: "Add APAC module" }));
    expect(db.rows("change_requests")).toHaveLength(1); // only the seeded one
  });

  it("rebaseline proposal", async () => {
    const before = db.rows("rebaselines").length;
    await expectNoPrincipal(await call(raiseRebaseline, orphanPat(), PROJECT, { reason: "dates slipped" }));
    expect(db.rows("rebaselines")).toHaveLength(before);
  });

  it("nothing is audited or announced for a refused request", async () => {
    await call(deleteProject, orphanPat(), PROJECT, { reason: "x" }, "DELETE");
    await call(raiseChange, orphanPat(), PROJECT, { title: "x" });
    expect(db.rows("audit_log")).toHaveLength(0);
    expect(emitted.requested).toHaveLength(0);
  });

  it("a token WITH an owner, and a session, still raise normally", async () => {
    expect((await call(raiseChange, alicePat(), PROJECT, { title: "Add APAC module" })).status).toBe(201);
    expect((await call(raiseRebaseline, session(ALICE), PROJECT, { reason: "dates slipped" })).status).toBe(201);
    expect((await call(deleteProject, alicePat(), PROJECT, { reason: "cancelled" }, "DELETE")).status).toBe(202);
  });
});

// ── M2: rebaseline states are terminal ────────────────────────────────────

describe("M2 — rebaseline lifecycle", () => {
  beforeEach(() => {
    const p = db.rows("projects").find((r) => r.id === PROJECT);
    if (p) p.is_locked = true; // apply needs a locked project (D11)
  });
  const status = (id: string) => db.rows("rebaselines").find((r) => r.id === id)?.status;

  it("a REJECTED rebaseline cannot be revived by flipping a vote", async () => {
    const res = await call(signoff, bobPat(), "rb-rejected", { vote: "go" });
    await expectRule(res, "rebaseline_not_pending");
    expect(status("rb-rejected")).toBe("rejected");
    expect(db.rows("rebaseline_signoffs")).toHaveLength(0);
  });

  it("an APPLIED rebaseline cannot regress to approved by a later vote", async () => {
    await expectRule(await call(signoff, bobPat(), "rb-applied", { vote: "go" }), "rebaseline_not_pending");
    expect(status("rb-applied")).toBe("applied");
  });

  it("an APPROVED rebaseline takes no further votes (no sign-off after the decision)", async () => {
    await expectRule(await call(signoff, bobPat(), "rb-approved", { vote: "no_go" }), "rebaseline_not_pending");
    expect(status("rb-approved")).toBe("approved");
  });

  it("a DRAFT (unlocked project) is not awaiting sign-off", async () => {
    await expectRule(await call(signoff, bobPat(), "rb-draft", { vote: "go" }), "rebaseline_not_pending");
    expect(status("rb-draft")).toBe("draft");
  });

  it("a pending one still decides normally", async () => {
    const res = await call(signoff, bobPat(), "rb-pending", { vote: "go" });
    expect(res.status).toBe(200);
    expect(status("rb-pending")).toBe("approved");
  });

  it("apply works once; the second apply is a 422 already_applied and runs the RPC only once", async () => {
    const applies = () => db.rpcCallsTo("nopm_apply_rebaseline").length;
    expect((await call(applyRebaseline, bobPat(), "rb-approved", {})).status).toBe(200);
    expect(applies()).toBe(1);
    await expectRule(await call(applyRebaseline, bobPat(), "rb-approved", {}), "already_applied");
    expect(applies()).toBe(1);
    expect(status("rb-approved")).toBe("applied");
  });

  it("apply is refused for every state but approved", async () => {
    for (const id of ["rb-pending", "rb-rejected", "rb-draft"]) {
      const res = await call(applyRebaseline, bobPat(), id, {});
      expect(res.status, id).toBe(422);
    }
    await expectRule(await call(applyRebaseline, bobPat(), "rb-applied", {}), "already_applied");
    expect(db.rpcCallsTo("nopm_apply_rebaseline")).toHaveLength(0);
  });

  it("losing the race on apply (the RPC finds it no longer approved) is a 422 and writes no audit row of its own", async () => {
    db.rpcHandlers.nopm_apply_rebaseline = () => ({ data: null, error: { code: "P0001", message: "ALREADY_DECIDED" } });
    await expectRule(await call(applyRebaseline, bobPat(), "rb-approved", {}), "already_applied");
    expect(auditActions()).not.toContain("rebaseline.apply");
  });
});

// ── M3: a decided change request is part of the record ────────────────────

describe("M3 — decided change requests cannot be edited or deleted", () => {
  const decided = ["approved", "rejected", "deferred", "implemented"];

  for (const status of decided) {
    it(`${status}: PATCH and DELETE are 422 change_request_decided, nothing changes`, async () => {
      Object.assign(db.rows("change_requests")[0], {
        status,
        decided_by: BOB,
        decided_by_id: BOB,
        decided_principal_id: BOB,
        decision_rationale: "ok",
      });
      await expectRule(await call(patchChange, alicePat(), "cr-1", { impact_cost: 1 }, "PATCH"), "change_request_decided");
      await expectRule(await call(deleteChange, alicePat(), "cr-1", undefined, "DELETE"), "change_request_decided");
      expect(db.rows("change_requests")).toHaveLength(1);
      expect(db.rows("change_requests")[0].impact_cost).toBe(1000);
      expect(db.rows("audit_log")).toHaveLength(0);
    });
  }

  it("an open (raised / under_review) change request is still editable and deletable", async () => {
    expect((await call(patchChange, alicePat(), "cr-1", { impact_cost: 2500 }, "PATCH")).status).toBe(200);
    expect(db.rows("change_requests")[0].impact_cost).toBe(2500);

    db.rows("change_requests")[0].status = "under_review";
    expect((await call(deleteChange, alicePat(), "cr-1", undefined, "DELETE")).status).toBe(204);
    expect(db.rows("change_requests")).toHaveLength(0);
    expect(auditActions()).toEqual(["change_request.update", "change_request.delete"]);
  });

  it("a decision landing between the read and the write wins (compare-and-set)", async () => {
    db.afterNextSelect("change_requests", (d) => {
      Object.assign(d.rows("change_requests")[0], { status: "approved", decided_by: BOB, decided_principal_id: BOB });
    });
    await expectRule(await call(patchChange, alicePat(), "cr-1", { impact_cost: 1 }, "PATCH"), "change_request_decided");
    expect(db.rows("change_requests")[0].impact_cost).toBe(1000);

    db.afterNextSelect("change_requests", (d) => {
      d.rows("change_requests")[0].status = "rejected";
    });
    db.rows("change_requests")[0].status = "raised";
    await expectRule(await call(deleteChange, alicePat(), "cr-1", undefined, "DELETE"), "change_request_decided");
    expect(db.rows("change_requests")).toHaveLength(1);
  });
});

// ── M4: a project deletion is bound to the scope that was requested ───────

describe("M4 — project deletion cannot cascade over records added after the request", () => {
  async function requestDeletion(): Promise<string> {
    const res = await call(deleteProject, alicePat(), PROJECT, { reason: "cancelled" }, "DELETE");
    expect(res.status).toBe(202);
    return String(db.rows("deletion_requests")[0].id);
  }

  it("the request snapshots the project AND what hangs off it", async () => {
    await requestDeletion();
    const before = db.rows("deletion_requests")[0].before as Row;
    expect(before).toMatchObject({ id: PROJECT, name: "Billing Migration" });
    expect(before.child_counts).toMatchObject({ tasks: 1, milestones: 0, risks: 0, change_requests: 1 });
    // ...and the audit row for the request carries the same snapshot.
    expect((db.rows("audit_log")[0].before as Row).child_counts).toEqual(before.child_counts);
  });

  it("approval is refused (422 children_changed) when tasks were added after the request; the project survives and the request stays pending", async () => {
    const id = await requestDeletion();
    db.rows("tasks").push({ id: "task-2", workspace_id: WS, name: "Added later", project_id: PROJECT });
    db.rows("tasks").push({ id: "task-3", workspace_id: WS, name: "Added later too", project_id: PROJECT });

    const res = await call(approveDeletion, bobPat(), id, {});
    const json = await expectRule(res, "children_changed");
    expect(json.error).toContain("raise a new request");
    expect(db.rows("projects")).toHaveLength(1);
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
  });

  it("...whichever kind of child it is (a risk / a milestone)", async () => {
    for (const table of ["risks", "milestones"]) {
      db = seed();
      holder.db = db;
      const id = await requestDeletion();
      db.rows(table).push({ id: `${table}-x`, workspace_id: WS, project_id: PROJECT });
      await expectRule(await call(approveDeletion, bobPat(), id, {}), "children_changed");
      expect(db.rows("projects"), table).toHaveLength(1);
    }
  });

  it("nothing changed since the request -> the approval commits as before", async () => {
    const id = await requestDeletion();
    const res = await call(approveDeletion, bobPat(), id, {});
    expect(res.status).toBe(200);
    expect(db.rows("projects")).toHaveLength(0);
  });

  it("a request raised before the snapshot existed (no child_counts) is not blocked", async () => {
    db.tables.deletion_requests = [
      {
        id: "del-legacy",
        workspace_id: WS,
        target_type: "project",
        target_id: PROJECT,
        status: "pending",
        requested_by_type: "user",
        requested_by_id: ALICE,
        requested_by_label: "Alice",
        requested_principal_id: ALICE,
        before: { id: PROJECT, name: "Billing Migration" },
      },
    ];
    expect((await call(approveDeletion, bobPat(), "del-legacy", {})).status).toBe(200);
  });
});

// ── Lark red-team: a pending change request edited after its card went out ──

describe("bait-and-switch — editing a PENDING change request", () => {
  const CR_VERSION = "2026-10-16T09:00:00.000Z";
  const material: Record<string, unknown>[] = [
    { title: "Extend go-live by a quarter" },
    { description: "now also covers the APAC rollout" },
    { category: "cost" },
    { priority: "critical" },
    { impact_summary: "+12 weeks" },
    { impact_schedule_days: 84 },
    { impact_cost: 250000 },
    { target_date: "2027-03-31" },
  ];

  for (const edit of material) {
    const [field] = Object.keys(edit);
    it(`changing ${field} re-issues the approval: one change event with the CURRENT content, after one audit row`, async () => {
      const res = await call(patchChange, alicePat(), "cr-1", edit, "PATCH");
      expect(res.status).toBe(200);
      expect(auditActions()).toEqual(["change_request.update"]);
      expect(emitted.changed).toHaveLength(1);
      expect(emitted.changed[0]).toMatchObject({
        workspaceId: WS,
        kind: "change_request",
        id: "cr-1",
        projectId: PROJECT,
        projectName: "Billing Migration",
        requesterPrincipalId: ALICE,
      });
      expect(emitted.requested).toHaveLength(0);
    });
  }

  it("the event shows the NEW title and impact, not the ones the first card showed", async () => {
    await call(patchChange, alicePat(), "cr-1", { title: "Add APAC module", impact_summary: "+8 weeks" }, "PATCH");
    expect(emitted.changed[0]).toMatchObject({
      title: "Change request CR-001: Add APAC module",
      summary: "+8 weeks",
    });
  });

  it("an edit that changes nothing material re-issues nothing: raised_at alone, or the stored values echoed back", async () => {
    await call(patchChange, alicePat(), "cr-1", { raised_at: "2026-10-01T00:00:00Z" }, "PATCH");
    await call(patchChange, alicePat(), "cr-1", { title: "Extend go-live", impact_cost: 1000 }, "PATCH");
    expect(emitted.changed).toHaveLength(0);
  });

  it("a refused edit (decided request) emits nothing", async () => {
    Object.assign(db.rows("change_requests")[0], { status: "approved", decided_by: BOB, decided_principal_id: BOB });
    await expectRule(await call(patchChange, alicePat(), "cr-1", { impact_cost: 1 }, "PATCH"), "change_request_decided");
    expect(emitted.changed).toHaveLength(0);
  });

  it("a decision that pins the version it saw is REFUSED (412) once the request was edited", async () => {
    // The approver's card or console showed CR_VERSION. The requester then edits; the table's trigger bumps updated_at.
    await call(patchChange, alicePat(), "cr-1", { impact_cost: 900000 }, "PATCH");
    db.rows("change_requests")[0].updated_at = "2026-10-16T09:05:00.000Z";

    const stale = await call(decideChange, bobPat(), "cr-1", {
      decision: "approve",
      rationale: "ok",
      expected_updated_at: CR_VERSION,
    });
    const json = await stale.json();
    expect(stale.status, JSON.stringify(json)).toBe(412);
    expect(db.rows("change_requests")[0].status).toBe("raised");
    expect(db.rows("audit_log").filter((r) => r.action === "change_request.decide")).toHaveLength(0);

    const fresh = await call(decideChange, bobPat(), "cr-1", {
      decision: "approve",
      rationale: "ok",
      expected_updated_at: "2026-10-16T09:05:00.000Z",
    });
    expect(fresh.status).toBe(200);
    expect(db.rows("change_requests")[0].status).toBe("approved");
  });

  it("the pin is optional: a decision without expected_updated_at behaves as before", async () => {
    const res = await call(decideChange, bobPat(), "cr-1", { decision: "approve", rationale: "ok" });
    expect(res.status).toBe(200);
  });

  it("an edit landing between the version check and the decision write loses to the pin (412, not a silent approval)", async () => {
    db.afterNextSelect("change_requests", (d) => {
      d.rows("change_requests")[0].updated_at = "2026-10-16T09:30:00.000Z";
      d.rows("change_requests")[0].impact_cost = 900000;
    });
    const res = await call(decideChange, bobPat(), "cr-1", {
      decision: "approve",
      rationale: "ok",
      expected_updated_at: CR_VERSION,
    });
    expect(res.status).toBe(412);
    expect(db.rows("change_requests")[0].status).toBe("raised");
  });

  it("a malformed expected_updated_at is a validation error, not a pass", async () => {
    const res = await call(decideChange, bobPat(), "cr-1", {
      decision: "approve",
      rationale: "ok",
      expected_updated_at: "yesterday",
    });
    expect(res.status).toBe(422);
  });
});
