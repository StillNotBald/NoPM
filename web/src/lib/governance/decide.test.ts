/**
 * Principal-aware four-eyes (2026-10-16, D1) — unit tests for the governed
 * decision paths in decide.ts. The Supabase admin client is replaced by an
 * in-memory fake (test-support/fake-admin.ts) whose deletion-commit RPC mirrors
 * the guard order of migration 0045; emit.ts is mocked so the events handed to
 * the Integration Hub can be inspected.
 *
 * The headline regression, repeated for every kind: the REQUESTER cannot decide
 * their own request by minting a PAT and using that instead of their session
 * (or the reverse) — four-eyes compares the HUMAN, not the actor id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Actor } from "@/lib/auth/guard";
import { ApiError, NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { FakeDb, type Row } from "./test-support/fake-admin";

const { holder, emitted } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  emitted: { requested: [] as unknown[], decided: [] as unknown[] },
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

import {
  approveDeletion,
  assertNotRequesterPrincipal,
  decideApproval,
  decideChangeRequest,
  decideTimesheet,
  principalOf,
  rejectDeletion,
  requirePrincipal,
  withdrawDeletion,
  NO_PRINCIPAL_MESSAGE,
} from "./decide";

// ── fixtures ──────────────────────────────────────────────────────────────

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

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

function pat(id: string, owner: string | null, scopes: string[], over: Partial<Actor> = {}): Actor {
  return {
    type: "token",
    id,
    tokenId: id,
    label: `${id}-agent`,
    workspaceId: WS,
    scopes,
    principalId: owner,
    channel: "api",
    requestId: `req-${id}`,
    ...over,
  };
}

const APPROVE_ALL = ["task:delete:approve", "project:delete:approve", "change:decide", "time:approve"];

/** Alice's own PAT, with every approve scope — the bypass attempt. */
const aliceOwnPat = () => pat("tok-alice", ALICE, APPROVE_ALL);
/** Bob's PAT: a different human. */
const bobPat = () => pat("tok-bob", BOB, APPROVE_ALL);
/** A legacy PAT with no recorded creator. */
const orphanPat = () => pat("tok-orphan", null, APPROVE_ALL);

let db: FakeDb;

function deletionRow(over: Row = {}): Row {
  return {
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
    ...over,
  };
}

function changeRow(over: Row = {}): Row {
  return {
    id: "cr-1",
    workspace_id: WS,
    project_id: "proj-1",
    reference_id: "CR-001",
    title: "Extend go-live",
    description: "slip",
    impact_summary: "+4 weeks",
    status: "raised",
    requested_by: ALICE,
    requested_by_type: "user",
    requested_by_id: ALICE,
    requested_by_label: "Alice",
    requested_principal_id: ALICE,
    ...over,
  };
}

function sheetRow(over: Row = {}): Row {
  return {
    id: "ts-1",
    workspace_id: WS,
    member_id: "member-1",
    period_start: "2026-10-12",
    period_end: "2026-10-18",
    hours_total: "38.5",
    entry_count: 5,
    status: "submitted",
    submitted_by: ALICE,
    submitted_by_type: "user",
    submitted_by_label: "Alice",
    submitted_principal_id: ALICE,
    ...over,
  };
}

function seed(extra: Record<string, Row[]> = {}): FakeDb {
  return new FakeDb({
    projects: [{ id: "proj-1", workspace_id: WS, name: "Billing Migration", is_locked: false }],
    tasks: [{ id: "task-1", workspace_id: WS, name: "Migrate billing DB", project_id: "proj-1" }],
    resource_members: [{ id: "member-1", workspace_id: WS, name: "Casey Member" }],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "admin" },
      { id: BOB, workspace_id: WS, role: "manager" },
    ],
    deletion_requests: [deletionRow()],
    change_requests: [changeRow()],
    timesheet_submissions: [sheetRow()],
    audit_log: [],
    notifications: [],
    ...extra,
  });
}

/** notify() is fire-and-forget; let its insert land before asserting on it. */
const flush = () => new Promise((r) => setTimeout(r, 0));

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the call to throw an ApiError, but it resolved");
}

beforeEach(() => {
  db = seed();
  holder.db = db;
  emitted.requested.length = 0;
  emitted.decided.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── principal helpers ─────────────────────────────────────────────────────

describe("principal helpers", () => {
  it("a session user is their own principal even if the Actor was built without the field", () => {
    expect(principalOf(session(ALICE, { principalId: undefined }))).toBe(ALICE);
  });

  it("a token's principal is its recorded owner and NEVER falls back to its own id", () => {
    expect(principalOf(pat("tok-1", BOB, []))).toBe(BOB);
    expect(principalOf(pat("tok-1", null, []))).toBeNull();
    expect(principalOf(pat("tok-1", null, [], { principalId: undefined }))).toBeNull();
  });

  it("requirePrincipal: null principal -> 403 no_principal with the documented message", () => {
    try {
      requirePrincipal(orphanPat());
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeError);
      expect((e as ScopeError).status).toBe(403);
      expect((e as ScopeError).code).toBe("no_principal");
      expect((e as ScopeError).message).toBe(NO_PRINCIPAL_MESSAGE);
      expect(NO_PRINCIPAL_MESSAGE).toBe("This token has no recorded owner, so it cannot approve (four-eyes)");
    }
  });

  it("assertNotRequesterPrincipal: equal humans -> 403 self_approval; different or unknown requester passes", () => {
    expect(() => assertNotRequesterPrincipal(ALICE, ALICE)).toThrowError(ScopeError);
    expect(() => assertNotRequesterPrincipal(ALICE, BOB)).not.toThrow();
    // A legacy row with no requester principal cannot be compared and passes.
    expect(() => assertNotRequesterPrincipal(null, ALICE)).not.toThrow();
    expect(() => assertNotRequesterPrincipal(undefined, ALICE)).not.toThrow();
  });
});

// ── deletion requests ─────────────────────────────────────────────────────

describe("approveDeletion", () => {
  it("REGRESSION: the requester cannot approve their own request with a PAT they minted (403 self_approval, nothing committed)", async () => {
    const err = await caught(approveDeletion(aliceOwnPat(), "del-1"));
    expect(err).toBeInstanceOf(ScopeError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("self_approval");
    expect(db.rpcCallsTo("nopm_commit_task_deletion")).toHaveLength(0);
    expect(db.rows("tasks")).toHaveLength(1);
    expect(db.rows("audit_log")).toHaveLength(0);
    expect(emitted.decided).toHaveLength(0);
  });

  it("the reverse: a request raised by Alice's PAT cannot be approved by Alice's session", async () => {
    db.tables.deletion_requests = [
      deletionRow({ requested_by_type: "token", requested_by_id: "tok-alice", requested_principal_id: ALICE }),
    ];
    const err = await caught(approveDeletion(session(ALICE), "del-1"));
    expect(err.status).toBe(403);
    expect(err.code).toBe("self_approval");
    expect(db.rpcCallsTo("nopm_commit_task_deletion")).toHaveLength(0);
  });

  it("two of the requester's own tokens cannot approve each other's requests", async () => {
    db.tables.deletion_requests = [
      deletionRow({ requested_by_type: "token", requested_by_id: "tok-alice-a", requested_principal_id: ALICE }),
    ];
    const err = await caught(approveDeletion(pat("tok-alice-b", ALICE, APPROVE_ALL), "del-1"));
    expect(err.status).toBe(403);
    expect(err.code).toBe("self_approval");
  });

  it("the same session actor is still refused (legacy actor-id check)", async () => {
    const err = await caught(approveDeletion(session(ALICE), "del-1"));
    expect(err.status).toBe(403);
    expect(err.code).toBe("self_approval");
  });

  it("a token with NO recorded owner can never approve (403 no_principal) — the RPC is not even called", async () => {
    const err = await caught(approveDeletion(orphanPat(), "del-1"));
    expect(err).toBeInstanceOf(ScopeError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("no_principal");
    expect(err.message).toBe(NO_PRINCIPAL_MESSAGE);
    expect(db.rpcCallsTo("nopm_commit_task_deletion")).toHaveLength(0);
  });

  it("wildcard scopes never grant approval (D2): `*` and `task:*` are refused as a missing scope", async () => {
    for (const scopes of [["*"], ["task:*"], ["*", "task:*", "project:*"]]) {
      const err = await caught(approveDeletion(pat("tok-bob", BOB, scopes), "del-1"));
      expect(err).toBeInstanceOf(ScopeError);
      expect(err.status).toBe(403);
      expect(err.message).toContain("task:delete:approve");
    }
    expect(db.rpcCallsTo("nopm_commit_task_deletion")).toHaveLength(0);
  });

  it("a different human's PAT approves: principal + note + provenance go to the RPC, one audit pair, one event", async () => {
    const out = await approveDeletion(bobPat(), "del-1", { note: "  checked with the owner  " });
    await flush();

    expect(out.result).toEqual({
      kind: "task_deletion",
      id: "del-1",
      status: "committed",
      title: 'Delete task "Migrate billing DB"',
      requesterPrincipalId: ALICE,
    });

    const [call] = db.rpcCallsTo("nopm_commit_task_deletion");
    expect(call.args).toMatchObject({
      p_request_id: "del-1",
      p_workspace_id: WS,
      p_approver_type: "token",
      p_approver_id: "tok-bob",
      p_approver_label: "tok-bob-agent",
      p_approver_principal_id: BOB,
      p_channel: "api",
      p_correlation_id: "req-tok-bob",
      p_note: "checked with the owner",
    });

    // The RPC wrote the audit rows (inside its transaction); the note and the
    // human behind the approver are recorded in the governance row (UC-12).
    const governance = db.rows("audit_log").find((r) => r.action === "deletion_request.approved");
    expect(governance?.after).toEqual({ status: "committed", approver_principal_id: BOB, note: "checked with the owner" });
    expect(db.rows("tasks")).toHaveLength(0);

    // The requester's HUMAN is told, never a token id.
    const notices = db.rows("notifications");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ recipient_id: ALICE, type: "approval.approved" });

    expect(emitted.decided).toEqual([
      {
        workspaceId: WS,
        kind: "task_deletion",
        id: "del-1",
        title: 'Delete task "Migrate billing DB"',
        summary: "duplicate",
        projectId: "proj-1",
        projectName: "Billing Migration",
        requestedByLabel: "Alice",
        requesterPrincipalId: ALICE,
        status: "committed",
        decidedByLabel: "tok-bob-agent (token)",
        channel: "api",
      },
    ]);
  });

  it("a blank note is sent as null, not an empty string", async () => {
    await approveDeletion(bobPat(), "del-1", { note: "   " });
    expect(db.rpcCallsTo("nopm_commit_task_deletion")[0].args.p_note).toBeNull();
  });

  it("a token-raised request is approved by a different human's session; its owner is notified", async () => {
    db.tables.deletion_requests = [
      deletionRow({ requested_by_type: "token", requested_by_id: "tok-alice", requested_by_label: "alice-agent", requested_principal_id: ALICE }),
    ];
    await approveDeletion(session(BOB), "del-1");
    await flush();
    expect(db.rows("notifications")[0]).toMatchObject({ recipient_id: ALICE });
    expect((emitted.decided[0] as { requestedByLabel: string }).requestedByLabel).toBe("alice-agent (token)");
  });

  it("a legacy request with no recorded requester principal can't be compared by human — only the actor-id check applies", async () => {
    db.tables.deletion_requests = [
      deletionRow({ requested_by_type: "token", requested_by_id: "tok-legacy", requested_principal_id: null }),
    ];
    // A different, owned token passes (nothing to compare it with) ...
    await expect(approveDeletion(bobPat(), "del-1")).resolves.toBeTruthy();
    // ... and the SAME token is still refused by the legacy check.
    db.tables.deletion_requests = [
      deletionRow({ id: "del-2", requested_by_type: "token", requested_by_id: "tok-bob", requested_principal_id: null }),
    ];
    const err = await caught(approveDeletion(bobPat(), "del-2"));
    expect(err.code).toBe("self_approval");
  });

  it("already decided -> 422 already_decided", async () => {
    db.tables.deletion_requests = [deletionRow({ status: "rejected" })];
    const err = await caught(approveDeletion(bobPat(), "del-1"));
    expect(err).toBeInstanceOf(RuleError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("already_decided");
  });

  it("unknown id, or another workspace's request -> 404", async () => {
    await expect(approveDeletion(bobPat(), "nope")).rejects.toBeInstanceOf(NotFoundError);
    db.tables.deletion_requests = [deletionRow({ workspace_id: "ws-other" })];
    await expect(approveDeletion(bobPat(), "del-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("project deletion needs project:delete:approve (task:delete:approve is not enough) and dispatches to the project RPC", async () => {
    db.tables.deletion_requests = [
      deletionRow({
        target_type: "project",
        target_id: "proj-1",
        before: { id: "proj-1", name: "Billing Migration" },
      }),
    ];
    const taskOnly = pat("tok-bob", BOB, ["task:delete:approve"]);
    const err = await caught(approveDeletion(taskOnly, "del-1"));
    expect(err.status).toBe(403);
    expect(err.message).toContain("project:delete:approve");

    const out = await approveDeletion(bobPat(), "del-1");
    expect(out.result.kind).toBe("project_deletion");
    expect(out.result.title).toBe('Delete project "Billing Migration"');
    expect(db.rpcCallsTo("nopm_commit_project_deletion")).toHaveLength(1);
    expect(db.rpcCallsTo("nopm_commit_task_deletion")).toHaveLength(0);
  });

  describe("RPC error mapping (the DB is the source of truth when the row changed under us)", () => {
    const failWith = (code: string, message: string) => {
      db.rpcHandlers.nopm_commit_task_deletion = () => ({ data: null, error: { code, message } });
    };

    it("P0003 SELF_APPROVAL -> 403 self_approval", async () => {
      failWith("P0003", "SELF_APPROVAL");
      const err = await caught(approveDeletion(bobPat(), "del-1"));
      expect([err.status, err.code]).toEqual([403, "self_approval"]);
    });
    it("P0006 NO_PRINCIPAL -> 403 no_principal", async () => {
      failWith("P0006", "NO_PRINCIPAL");
      const err = await caught(approveDeletion(bobPat(), "del-1"));
      expect([err.status, err.code]).toEqual([403, "no_principal"]);
    });
    it("P0001 ALREADY_DECIDED -> 422", async () => {
      failWith("P0001", "ALREADY_DECIDED");
      const err = await caught(approveDeletion(bobPat(), "del-1"));
      expect([err.status, err.code]).toEqual([422, "already_decided"]);
    });
    it("P0002 NOT_FOUND -> 404", async () => {
      failWith("P0002", "NOT_FOUND");
      await expect(approveDeletion(bobPat(), "del-1")).rejects.toBeInstanceOf(NotFoundError);
    });
    it("P0010 PROJECT_LOCKED -> 422", async () => {
      failWith("P0010", "PROJECT_LOCKED: frozen");
      const err = await caught(approveDeletion(bobPat(), "del-1"));
      expect(err.status).toBe(422);
    });
    it("anything else surfaces as an unexpected error (sanitised to a 500 by route())", async () => {
      failWith("XX000", "boom");
      await expect(approveDeletion(bobPat(), "del-1")).rejects.toThrow("boom");
    });
  });
});

describe("rejectDeletion", () => {
  it("REGRESSION: the requester cannot reject their own request with a PAT they minted (403 self_approval)", async () => {
    const err = await caught(rejectDeletion(aliceOwnPat(), "del-1", { reason: "changed my mind" }));
    expect(err.status).toBe(403);
    expect(err.code).toBe("self_approval");
    expect(db.rows("audit_log")).toHaveLength(0);
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
  });

  it("the same session actor keeps the historical 422", async () => {
    const err = await caught(rejectDeletion(session(ALICE), "del-1"));
    expect(err).toBeInstanceOf(RuleError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("self_approval");
  });

  it("a token with no recorded owner can never reject (403 no_principal)", async () => {
    const err = await caught(rejectDeletion(orphanPat(), "del-1"));
    expect([err.status, err.code]).toEqual([403, "no_principal"]);
  });

  it("wildcards don't grant the checker scope", async () => {
    const err = await caught(rejectDeletion(pat("tok-bob", BOB, ["*"]), "del-1"));
    expect(err.status).toBe(403);
    expect(err.message).toContain("task:delete:approve");
  });

  it("a different human rejects: approver principal + reason recorded, requester notified, event emitted", async () => {
    const out = await rejectDeletion(bobPat(), "del-1", { reason: " still needed " });
    await flush();

    expect(out.result.status).toBe("rejected");
    expect(db.rows("deletion_requests")[0]).toMatchObject({
      status: "rejected",
      approved_by_type: "token",
      approved_by_id: "tok-bob",
      approved_principal_id: BOB,
    });
    const audit = db.rows("audit_log");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "deletion_request.rejected",
      before: { status: "pending" },
      after: { status: "rejected", approver_principal_id: BOB, reason: "still needed" },
      channel: "api",
    });
    expect(db.rows("notifications")[0]).toMatchObject({ recipient_id: ALICE, type: "approval.rejected", body: "still needed" });
    expect(emitted.decided).toHaveLength(1);
    expect(emitted.decided[0]).toMatchObject({ kind: "task_deletion", status: "rejected", channel: "api" });
  });

  it("is a compare-and-set: losing the race is a 422, not a second audit row", async () => {
    db.afterNextSelect("deletion_requests", (d) => {
      d.rows("deletion_requests")[0].status = "committed";
    });
    const err = await caught(rejectDeletion(bobPat(), "del-1"));
    expect([err.status, err.code]).toEqual([422, "already_decided"]);
    expect(db.rows("audit_log")).toHaveLength(0);
  });
});

describe("withdrawDeletion", () => {
  const requesterTok = () => pat("tok-alice", ALICE, ["task:delete:request"]);

  it("only the original requester actor may withdraw", async () => {
    const err = await caught(withdrawDeletion(session(BOB), "del-1"));
    expect(err.status).toBe(403);
  });

  it("the original requester withdraws: audited, event emitted, no approver recorded", async () => {
    const out = await withdrawDeletion(session(ALICE), "del-1");
    expect(out.result.status).toBe("withdrawn");
    expect(db.rows("deletion_requests")[0]).toMatchObject({ status: "withdrawn" });
    expect(db.rows("deletion_requests")[0].approved_by_id).toBeUndefined();
    expect(db.rows("audit_log").map((r) => r.action)).toEqual(["deletion_request.withdrawn"]);
    expect(emitted.decided[0]).toMatchObject({ status: "withdrawn", decidedByLabel: "Alice" });
  });

  it("a token that raised it withdraws it", async () => {
    db.tables.deletion_requests = [deletionRow({ requested_by_type: "token", requested_by_id: "tok-alice" })];
    await expect(withdrawDeletion(requesterTok(), "del-1")).resolves.toBeTruthy();
  });

  it("an already-decided request can't be withdrawn", async () => {
    db.tables.deletion_requests = [deletionRow({ status: "committed" })];
    const err = await caught(withdrawDeletion(session(ALICE), "del-1"));
    expect(err.status).toBe(422);
  });
});

// ── change requests ───────────────────────────────────────────────────────

describe("decideChangeRequest", () => {
  const input = { decision: "approve" as const, rationale: "agreed with the sponsor" };

  it("REGRESSION: the requester cannot approve their own change request with a PAT they minted (403 self_approval)", async () => {
    const err = await caught(decideChangeRequest(aliceOwnPat(), "cr-1", input));
    expect(err.status).toBe(403);
    expect(err.code).toBe("self_approval");
    expect(db.rows("change_requests")[0].status).toBe("raised");
    expect(db.rows("audit_log")).toHaveLength(0);
    expect(emitted.decided).toHaveLength(0);
  });

  it("the reverse: raised through a PAT, decided from the owner's session -> 403", async () => {
    db.tables.change_requests = [
      changeRow({ requested_by: null, requested_by_type: "token", requested_by_id: "tok-alice", requested_principal_id: ALICE }),
    ];
    const err = await caught(decideChangeRequest(session(ALICE), "cr-1", input));
    expect([err.status, err.code]).toEqual([403, "self_approval"]);
  });

  it("the same session actor is still refused (legacy profile-id check)", async () => {
    db.tables.change_requests = [changeRow({ requested_principal_id: null })];
    const err = await caught(decideChangeRequest(session(ALICE), "cr-1", input));
    expect([err.status, err.code]).toEqual([403, "self_approval"]);
  });

  it("a token with no recorded owner can never decide (403 no_principal)", async () => {
    const err = await caught(decideChangeRequest(orphanPat(), "cr-1", input));
    expect([err.status, err.code]).toEqual([403, "no_principal"]);
  });

  it("wildcards don't grant change:decide (D2)", async () => {
    for (const scopes of [["*"], ["change:*"]]) {
      const err = await caught(decideChangeRequest(pat("tok-bob", BOB, scopes), "cr-1", input));
      expect(err.status).toBe(403);
      expect(err.message).toContain("change:decide");
    }
  });

  it("a different human decides: principal recorded, one audit row, requester notified, event emitted", async () => {
    const out = await decideChangeRequest(bobPat(), "cr-1", input);
    await flush();

    expect(out.result).toEqual({
      kind: "change_request",
      id: "cr-1",
      status: "approved",
      title: "Change request CR-001: Extend go-live",
      requesterPrincipalId: ALICE,
    });
    expect(out.row).toMatchObject({
      status: "approved",
      decided_by: null, // legacy profile column stays user-only
      decided_by_type: "token",
      decided_by_id: "tok-bob",
      decided_principal_id: BOB,
      decision_rationale: "agreed with the sponsor",
    });
    expect(db.rows("audit_log")).toHaveLength(1);
    expect(db.rows("audit_log")[0]).toMatchObject({ action: "change_request.decide", target_id: "cr-1", channel: "api" });
    expect(db.rows("notifications")[0]).toMatchObject({ recipient_id: ALICE });
    expect(emitted.decided).toEqual([
      {
        workspaceId: WS,
        kind: "change_request",
        id: "cr-1",
        title: "Change request CR-001: Extend go-live",
        summary: "+4 weeks",
        projectId: "proj-1",
        projectName: "Billing Migration",
        requestedByLabel: "Alice",
        requesterPrincipalId: ALICE,
        status: "approved",
        decidedByLabel: "tok-bob-agent (token)",
        channel: "api",
      },
    ]);
  });

  it("reject and defer map to rejected / deferred", async () => {
    const rejected = await decideChangeRequest(session(BOB), "cr-1", { decision: "reject", rationale: "no budget" });
    expect(rejected.result.status).toBe("rejected");
    db.tables.change_requests = [changeRow({ id: "cr-2" })];
    const deferred = await decideChangeRequest(session(BOB), "cr-2", { decision: "defer", rationale: "next quarter" });
    expect(deferred.result.status).toBe("deferred");
  });

  it("under_review is decidable; a decided request is a 422", async () => {
    db.tables.change_requests = [changeRow({ status: "under_review" })];
    await expect(decideChangeRequest(session(BOB), "cr-1", input)).resolves.toBeTruthy();
    db.tables.change_requests = [changeRow({ status: "approved" })];
    const err = await caught(decideChangeRequest(session(BOB), "cr-1", input));
    expect([err.status, err.code]).toEqual([422, "already_decided"]);
  });

  it("is a compare-and-set on status: a concurrent decider wins, we get a 422 and no second audit row", async () => {
    db.afterNextSelect("change_requests", (d) => {
      d.rows("change_requests")[0].status = "rejected";
    });
    const err = await caught(decideChangeRequest(session(BOB), "cr-1", input));
    expect([err.status, err.code]).toEqual([422, "already_decided"]);
    expect(db.rows("audit_log")).toHaveLength(0);
    expect(emitted.decided).toHaveLength(0);
    expect(db.rows("change_requests")[0].status).toBe("rejected"); // the winner's decision is intact
  });

  it("unknown id -> 404", async () => {
    await expect(decideChangeRequest(session(BOB), "nope", input)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── timesheets ────────────────────────────────────────────────────────────

describe("decideTimesheet", () => {
  it("REGRESSION: the submitter cannot approve, reject or reopen their own timesheet with a PAT they minted (403 self_approval)", async () => {
    for (const input of [
      { decision: "approved" as const },
      { decision: "rejected" as const, rationale: "no" },
    ]) {
      const err = await caught(decideTimesheet(aliceOwnPat(), "ts-1", input));
      expect([err.status, err.code]).toEqual([403, "self_approval"]);
    }
    db.tables.timesheet_submissions = [sheetRow({ status: "approved" })];
    const err = await caught(decideTimesheet(aliceOwnPat(), "ts-1", { decision: "reopened", rationale: "typo" }));
    expect([err.status, err.code]).toEqual([403, "self_approval"]);
    expect(db.rows("audit_log")).toHaveLength(0);
    expect(emitted.decided).toHaveLength(0);
  });

  it("the reverse: submitted through a PAT, decided from the owner's session -> 403", async () => {
    db.tables.timesheet_submissions = [
      sheetRow({ submitted_by: "tok-alice", submitted_by_type: "token", submitted_principal_id: ALICE }),
    ];
    const err = await caught(decideTimesheet(session(ALICE), "ts-1", { decision: "approved" }));
    expect([err.status, err.code]).toEqual([403, "self_approval"]);
  });

  it("the legacy compound actor check still applies", async () => {
    db.tables.timesheet_submissions = [sheetRow({ submitted_principal_id: null })];
    const err = await caught(decideTimesheet(session(ALICE), "ts-1", { decision: "approved" }));
    expect(err.status).toBe(403);
  });

  it("a token with no recorded owner can never decide (403 no_principal)", async () => {
    const err = await caught(decideTimesheet(orphanPat(), "ts-1", { decision: "approved" }));
    expect([err.status, err.code]).toEqual([403, "no_principal"]);
  });

  it("wildcards don't grant time:approve (D2)", async () => {
    for (const scopes of [["*"], ["time:*"]]) {
      const err = await caught(decideTimesheet(pat("tok-bob", BOB, scopes), "ts-1", { decision: "approved" }));
      expect(err.status).toBe(403);
      expect(err.message).toContain("time:approve");
    }
  });

  it("a different human approves: principal recorded, one audit row (with the approver's human), submitter notified, event emitted", async () => {
    const out = await decideTimesheet(bobPat(), "ts-1", { decision: "approved" });
    await flush();

    expect(out.result).toEqual({
      kind: "timesheet",
      id: "ts-1",
      status: "approved",
      title: "Timesheet: Casey Member, week of 2026-10-12",
      requesterPrincipalId: ALICE,
    });
    expect(db.rows("timesheet_submissions")[0]).toMatchObject({
      status: "approved",
      decided_by: "tok-bob",
      decided_by_type: "token",
      decided_principal_id: BOB,
    });
    expect(db.rows("audit_log")).toHaveLength(1);
    expect(db.rows("audit_log")[0]).toMatchObject({
      action: "timesheet.approved",
      after: { status: "approved", decision_rationale: null, approver_principal_id: BOB },
    });
    expect(db.rows("notifications")[0]).toMatchObject({ recipient_id: ALICE, type: "approval.approved" });
    expect(emitted.decided[0]).toMatchObject({
      kind: "timesheet",
      status: "approved",
      summary: "38.5 hours across 5 entries.",
      requesterPrincipalId: ALICE,
      projectId: null,
    });
  });

  it("reject and reopen require a rationale; reject stores it", async () => {
    const noWhy = await caught(decideTimesheet(session(BOB), "ts-1", { decision: "rejected" }));
    expect([noWhy.status, noWhy.code]).toEqual([422, "rationale_required"]);

    await decideTimesheet(session(BOB), "ts-1", { decision: "rejected", rationale: "hours look wrong" });
    expect(db.rows("timesheet_submissions")[0]).toMatchObject({ status: "rejected", decision_rationale: "hours look wrong" });

    db.tables.timesheet_submissions = [sheetRow({ id: "ts-2", status: "approved" })];
    const noWhyReopen = await caught(decideTimesheet(session(BOB), "ts-2", { decision: "reopened" }));
    expect(noWhyReopen.code).toBe("rationale_required");
  });

  it("reopen clears every decided_* column (including the principal), returns the sheet to 'submitted', and notifies approvers", async () => {
    db.tables.timesheet_submissions = [
      sheetRow({
        status: "approved",
        decided_by: BOB,
        decided_by_type: "user",
        decided_by_label: "Bob",
        decided_principal_id: BOB,
        decided_at: "2026-10-14T00:00:00Z",
        decision_rationale: "ok",
      }),
    ];
    const out = await decideTimesheet(session(BOB), "ts-1", { decision: "reopened", rationale: "missed a day" });
    await flush();

    expect(out.result.status).toBe("submitted");
    expect(db.rows("timesheet_submissions")[0]).toMatchObject({
      status: "submitted",
      decided_by: null,
      decided_by_type: null,
      decided_by_label: null,
      decided_principal_id: null,
      decided_at: null,
      decision_rationale: null,
    });
    expect(db.rows("audit_log")[0]).toMatchObject({ action: "timesheet.reopened", after: { status: "submitted", rationale: "missed a day" } });
    expect(db.rows("notifications").map((n) => n.type)).toEqual(["approval.requested", "approval.requested"]);
    expect(emitted.decided[0]).toMatchObject({ status: "reopened" });
  });

  it("verb preconditions: decide only 'submitted', reopen only 'approved'", async () => {
    db.tables.timesheet_submissions = [sheetRow({ status: "approved" })];
    const decided = await caught(decideTimesheet(session(BOB), "ts-1", { decision: "approved" }));
    expect([decided.status, decided.code]).toEqual([422, "already_decided"]);

    db.tables.timesheet_submissions = [sheetRow({ status: "submitted" })];
    const reopen = await caught(decideTimesheet(session(BOB), "ts-1", { decision: "reopened", rationale: "x" }));
    expect([reopen.status, reopen.code]).toEqual([422, "not_reopenable"]);
  });

  it("is a compare-and-set on status: losing the race is a 422 and writes no audit row", async () => {
    db.afterNextSelect("timesheet_submissions", (d) => {
      d.rows("timesheet_submissions")[0].status = "approved";
    });
    const err = await caught(decideTimesheet(session(BOB), "ts-1", { decision: "approved" }));
    expect([err.status, err.code]).toEqual([422, "already_decided"]);
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("unknown id -> 404", async () => {
    await expect(decideTimesheet(session(BOB), "nope", { decision: "approved" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── decideApproval: the one entry point the Integration Hub calls ─────────

describe("decideApproval", () => {
  /** A chat-connector actor: a verified linked profile, channel derived server-side. */
  const larkActor = (id = BOB) =>
    session(id, { channel: "lark", viaConnectorId: "conn-1", externalEventId: "evt-1", externalActorRef: "lark:tenant:ou_x" });

  it("reject requires a non-empty note, for every kind (422 rationale_required)", async () => {
    for (const kind of ["task_deletion", "project_deletion", "change_request", "timesheet"] as const) {
      for (const note of [undefined, "", "   "]) {
        const err = await caught(decideApproval(larkActor(), { kind, id: "x" }, "reject", note));
        expect([err.status, err.code]).toEqual([422, "rationale_required"]);
      }
    }
  });

  it("approves a task deletion from a chat card: lark provenance reaches the RPC and the event", async () => {
    const res = await decideApproval(larkActor(), { kind: "task_deletion", id: "del-1" }, "approve", "ok from chat");
    expect(res).toEqual({
      kind: "task_deletion",
      id: "del-1",
      status: "committed",
      title: 'Delete task "Migrate billing DB"',
      requesterPrincipalId: ALICE,
    });
    const [call] = db.rpcCallsTo("nopm_commit_task_deletion");
    expect(call.args).toMatchObject({ p_channel: "lark", p_approver_principal_id: BOB, p_note: "ok from chat" });
    // The connector provenance is forwarded to the RPC and lands on BOTH audit rows it writes.
    expect(call.args).toMatchObject({
      p_via_connector_id: "conn-1",
      p_external_event_id: "evt-1",
      p_external_actor_ref: "lark:tenant:ou_x",
    });
    const audit = db.rows("audit_log");
    expect(audit).toHaveLength(2);
    for (const row of audit) {
      expect(row).toMatchObject({
        channel: "lark",
        via_connector_id: "conn-1",
        external_event_id: "evt-1",
        external_actor_ref: "lark:tenant:ou_x",
      });
    }
    expect(emitted.decided[0]).toMatchObject({ channel: "lark", decidedByLabel: "Bob", status: "committed" });
  });

  it("outside a connector the provenance params are null, never undefined (REST / console / CLI / MCP)", async () => {
    await approveDeletion(bobPat(), "del-1");
    expect(db.rpcCallsTo("nopm_commit_task_deletion")[0].args).toMatchObject({
      p_via_connector_id: null,
      p_external_event_id: null,
      p_external_actor_ref: null,
    });
  });

  it("rejects a project deletion with the reason", async () => {
    db.tables.deletion_requests = [
      deletionRow({ target_type: "project", target_id: "proj-1", before: { name: "Billing Migration" } }),
    ];
    const res = await decideApproval(larkActor(), { kind: "project_deletion", id: "del-1" }, "reject", "keep it");
    expect(res).toMatchObject({ kind: "project_deletion", status: "rejected" });
    expect(db.rows("audit_log")[0]).toMatchObject({ channel: "lark", after: { reason: "keep it" } });
  });

  it("a ref whose kind doesn't match the stored target type is a 404 (a task card can't decide a project request)", async () => {
    db.tables.deletion_requests = [deletionRow({ target_type: "project", target_id: "proj-1" })];
    await expect(
      decideApproval(larkActor(), { kind: "task_deletion", id: "del-1" }, "approve"),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(db.rpcCallsTo("nopm_commit_project_deletion")).toHaveLength(0);
  });

  it("approving a change request with no note defaults the mandatory rationale to the channel", async () => {
    const res = await decideApproval(larkActor(), { kind: "change_request", id: "cr-1" }, "approve");
    expect(res).toMatchObject({ kind: "change_request", status: "approved" });
    expect(db.rows("change_requests")[0].decision_rationale).toBe("Approved via lark");
  });

  it("rejecting a change request uses the note as the rationale", async () => {
    const res = await decideApproval(larkActor(), { kind: "change_request", id: "cr-1" }, "reject", "out of scope");
    expect(res.status).toBe("rejected");
    expect(db.rows("change_requests")[0].decision_rationale).toBe("out of scope");
  });

  it("approves a timesheet with no note; rejects with the note as the rationale", async () => {
    const approved = await decideApproval(larkActor(), { kind: "timesheet", id: "ts-1" }, "approve");
    expect(approved).toMatchObject({ kind: "timesheet", status: "approved" });
    expect(db.rows("timesheet_submissions")[0].decision_rationale).toBeNull();

    db.tables.timesheet_submissions = [sheetRow({ id: "ts-2" })];
    const rejected = await decideApproval(larkActor(), { kind: "timesheet", id: "ts-2" }, "reject", "wrong week");
    expect(rejected.status).toBe("rejected");
  });

  it("four-eyes holds through the hub: the requester's own linked account can't decide from chat either", async () => {
    for (const kind of ["task_deletion", "change_request", "timesheet"] as const) {
      const id = kind === "task_deletion" ? "del-1" : kind === "change_request" ? "cr-1" : "ts-1";
      const err = await caught(decideApproval(larkActor(ALICE), { kind, id }, "approve"));
      expect(err.status, kind).toBe(403);
      expect(err.code, kind).toBe("self_approval");
    }
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("a viewer can't decide (scope), and an unknown kind is rejected", async () => {
    const viewer = session(BOB, { role: "viewer", channel: "lark" });
    const err = await caught(decideApproval(viewer, { kind: "timesheet", id: "ts-1" }, "approve"));
    expect(err.status).toBe(403);

    const bad = await caught(
      decideApproval(larkActor(), { kind: "bogus" as never, id: "x" }, "approve"),
    );
    expect(bad.status).toBe(422);
  });

  it("an emit failure can never turn a committed decision into an error", async () => {
    vi.resetModules();
    // Re-import decide.ts against an emit that throws.
    vi.doMock("@/lib/integrations/emit", () => ({
      emitApprovalRequested: () => {
        throw new Error("hub down");
      },
      emitApprovalDecided: () => {
        throw new Error("hub down");
      },
    }));
    const fresh = await import("./decide");
    const res = await fresh.decideApproval(larkActor(), { kind: "timesheet", id: "ts-1" }, "approve");
    expect(res.status).toBe("approved");
    vi.doUnmock("@/lib/integrations/emit");
  });
});
