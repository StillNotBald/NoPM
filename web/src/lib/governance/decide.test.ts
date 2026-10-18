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

const { holder, emitted, storageRemoved } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  emitted: { requested: [] as unknown[], decided: [] as unknown[] },
  storageRemoved: { calls: [] as unknown[][] },
}));

vi.mock("@/lib/governance/project-files", () => ({
  removeStoredFiles: async (paths: unknown, workspaceId: string) => void storageRemoved.calls.push([paths, workspaceId]),
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
  changeRequestEvent,
  decideApproval,
  decideChangeRequest,
  principalOf,
  rejectDeletion,
  requireMakerPrincipal,
  requirePrincipal,
  withdrawDeletion,
  CHILDREN_CHANGED_MESSAGE,
  NO_MAKER_PRINCIPAL_MESSAGE,
  NO_PRINCIPAL_MESSAGE,
  TARGET_CHANGED_MESSAGE,
  TARGET_GONE_MESSAGE,
  noteLegacyRequesterUnknown,
} from "./decide";

// ── fixtures ──────────────────────────────────────────────────────────────

const WS = "ws-1";
/** The version (updated_at) of the seeded change request: approve / reject must name it (Q-GOV-13). */
const V0 = "2026-10-16T09:00:00.000Z";
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
    principalRole: owner ? "manager" : null,
    channel: "api",
    requestId: `req-${id}`,
    ...over,
  };
}

const APPROVE_ALL = ["task:delete:approve", "project:delete:approve", "change:decide"];

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
    updated_at: V0,
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
  storageRemoved.calls.length = 0;
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

  it("requireMakerPrincipal (R1/H3): the MAKER side fails closed too — an ownerless token cannot raise, a session or an owned token can", () => {
    try {
      requireMakerPrincipal(orphanPat());
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeError);
      expect((e as ScopeError).status).toBe(403);
      expect((e as ScopeError).code).toBe("no_principal");
      expect((e as ScopeError).message).toBe(NO_MAKER_PRINCIPAL_MESSAGE);
    }
    expect(requireMakerPrincipal(session(ALICE))).toBe(ALICE);
    expect(requireMakerPrincipal(pat("tok-bob", BOB, []))).toBe(BOB);
    // The session fallback holds even if the Actor was built without the field.
    expect(requireMakerPrincipal(session(ALICE, { principalId: undefined }))).toBe(ALICE);
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

describe("approveDeletion — DB errors that map to a clean 422 (migration 0049)", () => {
  const projectRequest = () =>
    deletionRow({
      id: "del-p",
      target_type: "project",
      target_id: "proj-1",
      before: { id: "proj-1", name: "Billing Migration", child_counts: { tasks: 1 } },
    });

  async function approveWithRpcError(error: { message: string; code: string }): Promise<ApiError> {
    db.tables.deletion_requests = [projectRequest()];
    db.rpcHandlers.nopm_commit_project_deletion = () => ({ data: null, error });
    return caught(approveDeletion(bobPat(), "del-p"));
  }

  it("CHILDREN_CHANGED / P0016 -> 422 children_changed (the project gained records since the request)", async () => {
    for (const error of [
      { message: "CHILDREN_CHANGED: the project gained records", code: "P0016" },
      { message: "something else", code: "P0016" },
      { message: "CHILDREN_CHANGED", code: "XX000" },
    ]) {
      const err = await approveWithRpcError(error);
      expect([err.status, err.code, err.message]).toEqual([422, "children_changed", CHILDREN_CHANGED_MESSAGE]);
    }
  });

  it("an unknown database error is still not swallowed into a 4xx", async () => {
    db.tables.deletion_requests = [projectRequest()];
    db.rpcHandlers.nopm_commit_project_deletion = () => ({ data: null, error: { message: "boom", code: "XX000" } });
    await expect(approveDeletion(bobPat(), "del-p")).rejects.toThrow("boom");
  });
});

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

  it("G6: deciding a legacy request with no requester principal writes a four_eyes.legacy_requester_unknown audit row", async () => {
    db.tables.deletion_requests = [
      deletionRow({ requested_by_type: "token", requested_by_id: "tok-legacy", requested_principal_id: null }),
    ];
    await approveDeletion(bobPat(), "del-1");
    const rows = db.rows("audit_log").filter((a) => a.action === "four_eyes.legacy_requester_unknown");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_type: "deletion_request", target_id: "del-1" });
  });

  it("G6: a refused attempt (reject with no reason) writes no legacy row; the committed reject writes exactly one", async () => {
    db.tables.deletion_requests = [
      deletionRow({ requested_by_type: "token", requested_by_id: "tok-legacy", requested_principal_id: null }),
    ];
    const err = await caught(rejectDeletion(bobPat(), "del-1", {}));
    expect(err.code).toBe("rationale_required");
    expect(db.rows("audit_log").filter((a) => a.action === "four_eyes.legacy_requester_unknown")).toHaveLength(0);
    await rejectDeletion(bobPat(), "del-1", { reason: "not needed" });
    expect(db.rows("audit_log").filter((a) => a.action === "four_eyes.legacy_requester_unknown")).toHaveLength(1);
  });

  it("G6: a request that has a requester principal writes no legacy row; a failing audit write never blocks", async () => {
    await noteLegacyRequesterUnknown(bobPat(), "change_request", { id: "cr-1", requested_principal_id: ALICE }, "decide");
    expect(db.rows("audit_log").filter((a) => a.action === "four_eyes.legacy_requester_unknown")).toHaveLength(0);
    const original = db.client.from;
    db.client.from = (() => {
      throw new Error("audit down");
    }) as typeof db.client.from;
    await expect(
      noteLegacyRequesterUnknown(bobPat(), "change_request", { id: "cr-1", requested_principal_id: null }, "decide"),
    ).resolves.toBeUndefined();
    db.client.from = original;
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
    it("P0017 TARGET_GONE -> 422 target_gone, and the stale request is closed (withdrawn), not left pending", async () => {
      failWith("P0017", "TARGET_GONE: the task no longer exists");
      const err = await caught(approveDeletion(bobPat(), "del-1"));
      expect([err.status, err.code, err.message]).toEqual([422, "target_gone", TARGET_GONE_MESSAGE]);

      const req = db.rows("deletion_requests").find((r) => r.id === "del-1")!;
      expect(req.status).toBe("withdrawn");
      expect(req.approved_by_id ?? null).toBeNull(); // closed without a decision: no approver recorded
      const actions = db.rows("audit_log").map((a) => a.action);
      expect(actions).toEqual(["deletion_request.withdrawn"]); // no task.delete naming the approver
      expect(db.rows("audit_log")[0].after).toMatchObject({ status: "withdrawn", reason: "target_gone" });
    });
    it("A3-5: if the close cannot be audited it fails closed — the request goes back to pending and the audit error surfaces", async () => {
      failWith("P0017", "TARGET_GONE: the task no longer exists");
      const realFrom = db.client.from;
      db.client.from = (table: string) => {
        if (table === "audit_log") {
          return {
            insert: () => ({ then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "audit down" } }).then(res) }),
          } as never;
        }
        return realFrom(table);
      };
      await expect(approveDeletion(bobPat(), "del-1")).rejects.toThrow(/Fail-closed audit write failed/);
      const req = db.rows("deletion_requests").find((r) => r.id === "del-1")!;
      expect(req.status).toBe("pending"); // not closed without a trail
    });
    it("P0017 on a project deletion maps the same way", async () => {
      db.rows("deletion_requests")[0] = deletionRow({
        target_type: "project",
        target_id: "proj-1",
        before: { id: "proj-1", name: "Billing Migration" },
      });
      db.rpcHandlers.nopm_commit_project_deletion = () => ({ data: null, error: { code: "P0017", message: "TARGET_GONE" } });
      const err = await caught(approveDeletion(bobPat(), "del-1"));
      expect([err.status, err.code]).toEqual([422, "target_gone"]);
      expect(db.rows("deletion_requests")[0].status).toBe("withdrawn");
    });
    it("the fake commit RPC (which mirrors 0056) refuses to commit a task that no longer exists", async () => {
      db.tables.tasks = []; // already cascade-deleted
      const err = await caught(approveDeletion(bobPat(), "del-1"));
      expect([err.status, err.code]).toEqual([422, "target_gone"]);
      expect(db.rows("audit_log").some((a) => a.action === "task.delete")).toBe(false);
      expect(db.rows("deletion_requests")[0].status).toBe("withdrawn");
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
    const err = await caught(rejectDeletion(session(ALICE), "del-1", { reason: "no" }));
    expect(err).toBeInstanceOf(RuleError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("self_approval");
  });

  it("a token with no recorded owner can never reject (403 no_principal)", async () => {
    const err = await caught(rejectDeletion(orphanPat(), "del-1", { reason: "no" }));
    expect([err.status, err.code]).toEqual([403, "no_principal"]);
  });

  it("wildcards don't grant the checker scope", async () => {
    const err = await caught(rejectDeletion(pat("tok-bob", BOB, ["*"]), "del-1", { reason: "no" }));
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
    const err = await caught(rejectDeletion(bobPat(), "del-1", { reason: "no" }));
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
  const input = { decision: "approve" as const, rationale: "agreed with the sponsor", expected_updated_at: V0 };

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
        version: V0,
      },
    ]);
  });

  it("reject and defer map to rejected / deferred", async () => {
    const rejected = await decideChangeRequest(session(BOB), "cr-1", { decision: "reject", rationale: "no budget", expected_updated_at: V0 });
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

  describe("version pin (expected_updated_at) — bait-and-switch guard", () => {
    const SEEN = "2026-10-16T09:00:00.000Z";
    beforeEach(() => {
      db.tables.change_requests = [changeRow({ updated_at: SEEN })];
    });

    it("the version the approver saw still current -> the decision goes through", async () => {
      const out = await decideChangeRequest(session(BOB), "cr-1", { ...input, expected_updated_at: SEEN });
      expect(out.result.status).toBe("approved");
    });

    it("the same instant written with different precision still matches (R-90 tolerance)", async () => {
      await decideChangeRequest(session(BOB), "cr-1", { ...input, expected_updated_at: "2026-10-16T09:00:00Z" });
      expect(db.rows("change_requests")[0].status).toBe("approved");
    });

    it("the request was edited since -> 412, nothing decided, nothing audited, nothing announced", async () => {
      db.rows("change_requests")[0].updated_at = "2026-10-16T09:05:00.000Z";
      const err = await caught(decideChangeRequest(session(BOB), "cr-1", { ...input, expected_updated_at: SEEN }));
      expect(err.status).toBe(412);
      expect(db.rows("change_requests")[0].status).toBe("raised");
      expect(db.rows("audit_log")).toHaveLength(0);
      expect(emitted.decided).toHaveLength(0);
    });

    it("Q-GOV-13: no pin on approve or reject -> 422 version_required, nothing decided", async () => {
      const { expected_updated_at: _drop, ...noPin } = input;
      void _drop;
      for (const decision of ["approve", "reject"] as const) {
        const err = await caught(decideChangeRequest(session(BOB), "cr-1", { ...noPin, decision }));
        expect([err.status, err.code]).toEqual([422, "version_required"]);
      }
      expect(db.rows("change_requests")[0].status).toBe("raised");
      expect(db.rows("audit_log")).toHaveLength(0);
    });

    it("a stale pin is refused with the plain-words message", async () => {
      db.rows("change_requests")[0].updated_at = "2026-10-16T09:05:00.000Z";
      const err = await caught(decideChangeRequest(session(BOB), "cr-1", { ...input, expected_updated_at: SEEN }));
      expect(err.status).toBe(412);
      expect(err.message).toBe("This request changed after you opened it. Reopen it and review the new version.");
    });

    it("defer decides nothing on content, so it needs no pin", async () => {
      const { expected_updated_at: _drop, ...noPin } = input;
      void _drop;
      const out = await decideChangeRequest(session(BOB), "cr-1", { ...noPin, decision: "defer", rationale: "next quarter" });
      expect(out.result.status).toBe("deferred");
    });

    it("an edit between the check and the write is a 412, not 'already decided' and not an approval", async () => {
      db.afterNextSelect("change_requests", (d) => {
        d.rows("change_requests")[0].updated_at = "2026-10-16T09:30:00.000Z";
      });
      const err = await caught(decideChangeRequest(session(BOB), "cr-1", { ...input, expected_updated_at: SEEN }));
      expect(err.status).toBe(412);
      expect(db.rows("change_requests")[0].status).toBe("raised");
    });

    it("the self-approval refusal still comes first (a stale pin never leaks that the request changed)", async () => {
      db.rows("change_requests")[0].updated_at = "2026-10-16T09:05:00.000Z";
      const err = await caught(decideChangeRequest(aliceOwnPat(), "cr-1", { ...input, expected_updated_at: SEEN }));
      expect([err.status, err.code]).toEqual([403, "self_approval"]);
    });

    it("decideApproval (the chat-card entry point) carries the version the card was issued for", async () => {
      db.rows("change_requests")[0].updated_at = "2026-10-16T09:05:00.000Z";
      const stale = await caught(
        decideApproval(session(BOB), { kind: "change_request", id: "cr-1" }, "approve", undefined, { expectedUpdatedAt: SEEN }),
      );
      expect(stale.status).toBe(412);
      const ok = await decideApproval(session(BOB), { kind: "change_request", id: "cr-1" }, "approve", undefined, {
        expectedUpdatedAt: "2026-10-16T09:05:00.000Z",
      });
      expect(ok.status).toBe("approved");
    });
  });

  it("unknown id -> 404", async () => {
    await expect(decideChangeRequest(session(BOB), "nope", input)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── decideApproval: the one entry point the Integration Hub calls ─────────

describe("decideApproval", () => {
  /** A chat-connector actor: a verified linked profile, channel derived server-side. */
  const larkActor = (id = BOB) =>
    session(id, { channel: "lark", viaConnectorId: "conn-1", externalEventId: "evt-1", externalActorRef: "lark:tenant:ou_x" });

  it("D-16: a member or viewer (session or token principal) is 403 role_not_permitted on every kind and verb", async () => {
    for (const actor of [larkActor(BOB), bobPat()]) {
      const demoted = { ...actor, ...(actor.type === "user" ? { role: "member" } : { principalRole: "member" }) } as Actor;
      for (const [kind, id] of [["task_deletion", "del-1"], ["change_request", "cr-1"]] as const) {
        for (const action of ["approve", "reject"] as const) {
          const err = await caught(decideApproval(demoted, { kind, id }, action, "because"));
          expect([err.status, err.code, err.message]).toEqual([403, "role_not_permitted", "Only managers and admins can approve"]);
        }
      }
    }
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("reject requires a non-empty note, for every kind (422 rationale_required)", async () => {
    for (const kind of ["task_deletion", "project_deletion", "change_request"] as const) {
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

  it("Q-GOV-21: approving a change request with no note stores NO invented rationale (no \"Approved via lark\")", async () => {
    const res = await decideApproval(larkActor(), { kind: "change_request", id: "cr-1" }, "approve", undefined, {
      expectedUpdatedAt: V0,
    });
    expect(res).toMatchObject({ kind: "change_request", status: "approved" });
    expect(db.rows("change_requests")[0].decision_rationale).toBeNull();
  });

  it("rejecting a change request uses the note as the rationale", async () => {
    const res = await decideApproval(larkActor(), { kind: "change_request", id: "cr-1" }, "reject", "out of scope", {
      expectedUpdatedAt: V0,
    });
    expect(res.status).toBe("rejected");
    expect(db.rows("change_requests")[0].decision_rationale).toBe("out of scope");
  });

  it("four-eyes holds through the hub: the requester's own linked account can't decide from chat either", async () => {
    for (const kind of ["task_deletion", "change_request"] as const) {
      const id = kind === "task_deletion" ? "del-1" : "cr-1";
      const err = await caught(decideApproval(larkActor(ALICE), { kind, id }, "approve"));
      expect(err.status, kind).toBe(403);
      expect(err.code, kind).toBe("self_approval");
    }
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("a viewer can't decide (scope), and an unknown kind is rejected", async () => {
    const viewer = session(BOB, { role: "viewer", channel: "lark" });
    const err = await caught(decideApproval(viewer, { kind: "task_deletion", id: "del-1" }, "approve"));
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
    const res = await fresh.decideApproval(larkActor(), { kind: "change_request", id: "cr-1" }, "approve", undefined, {
      expectedUpdatedAt: V0,
    });
    expect(res.status).toBe("approved");
    vi.doUnmock("@/lib/integrations/emit");
  });
});

// ── CR-gov fixes (P2-15, P2-6, P2-16, P2-7, P2-2) ─────────────────────────

describe("approveDeletion — a task approval is bound to the task as requested (P2-15)", () => {
  const REQUESTED = "2026-10-16T09:00:00.123456+00:00";

  function taskRequest(updatedAt: string | undefined = REQUESTED) {
    db.tables.deletion_requests = [
      deletionRow({
        before: { id: "task-1", name: "Migrate billing DB", project_id: "proj-1", ...(updatedAt ? { updated_at: updatedAt } : {}) },
      }),
    ];
  }

  it("the task was edited after the request -> 422 target_changed; nothing deleted, request still pending, nothing announced", async () => {
    taskRequest();
    db.rows("tasks")[0].updated_at = "2026-10-16T09:30:00.000000+00:00";
    const err = await caught(approveDeletion(bobPat(), "del-1"));
    expect([err.status, err.code, err.message]).toEqual([422, "target_changed", TARGET_CHANGED_MESSAGE]);
    expect(db.rpcCallsTo("nopm_commit_task_deletion")).toHaveLength(0);
    expect(db.rows("tasks")).toHaveLength(1);
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
    expect(db.rows("audit_log")).toHaveLength(0);
    expect(emitted.decided).toHaveLength(0);
  });

  it("the task is exactly as requested -> the approval commits", async () => {
    taskRequest();
    db.rows("tasks")[0].updated_at = REQUESTED;
    const out = await approveDeletion(bobPat(), "del-1");
    expect(out.result.status).toBe("committed");
    expect(db.rows("tasks")).toHaveLength(0);
  });

  it("the same instant written with different precision still matches", async () => {
    taskRequest("2026-10-16T09:00:00Z");
    db.rows("tasks")[0].updated_at = "2026-10-16T09:00:00.000+00:00";
    await expect(approveDeletion(bobPat(), "del-1")).resolves.toBeTruthy();
  });

  it("a legacy request with no recorded version cannot be compared and still commits", async () => {
    taskRequest("");
    db.rows("tasks")[0].updated_at = "2026-10-16T09:30:00.000+00:00";
    await expect(approveDeletion(bobPat(), "del-1")).resolves.toBeTruthy();
  });

  it("the check runs after the four-eyes guards: the requester still gets self_approval, not target_changed", async () => {
    taskRequest();
    db.rows("tasks")[0].updated_at = "2026-10-16T09:30:00.000+00:00";
    const err = await caught(approveDeletion(aliceOwnPat(), "del-1"));
    expect(err.code).toBe("self_approval");
  });

  it("rejecting or withdrawing a stale request is still allowed (only an approval is bound)", async () => {
    taskRequest();
    db.rows("tasks")[0].updated_at = "2026-10-16T09:30:00.000+00:00";
    expect((await rejectDeletion(bobPat(), "del-1", { reason: "stale" })).result.status).toBe("rejected");
    taskRequest();
    expect((await withdrawDeletion(session(ALICE), "del-1")).result.status).toBe("withdrawn");
  });

  it("project deletions are untouched by the task check", async () => {
    db.tables.deletion_requests = [
      deletionRow({
        id: "del-p",
        target_type: "project",
        target_id: "proj-1",
        before: { id: "proj-1", name: "Billing Migration", updated_at: REQUESTED },
      }),
    ];
    db.rows("projects")[0].updated_at = "2026-10-16T09:30:00.000+00:00";
    await expect(approveDeletion(bobPat(), "del-p")).resolves.toBeTruthy();
  });
});

describe("withdrawDeletion — the person behind a token may withdraw (P2-6)", () => {
  const tokenRaised = () =>
    deletionRow({ requested_by_type: "token", requested_by_id: "tok-alice", requested_principal_id: ALICE });

  it("Alice's session withdraws a request raised by her (now gone) token", async () => {
    db.tables.deletion_requests = [tokenRaised()];
    const out = await withdrawDeletion(session(ALICE), "del-1");
    expect(out.result.status).toBe("withdrawn");
    expect(db.rows("deletion_requests")[0].status).toBe("withdrawn");
    expect(db.rows("audit_log").map((r) => r.action)).toEqual(["deletion_request.withdrawn"]);
  });

  it("another token of Alice's also withdraws it (same human)", async () => {
    db.tables.deletion_requests = [tokenRaised()];
    await expect(withdrawDeletion(pat("tok-alice-2", ALICE, ["task:delete:request"]), "del-1")).resolves.toBeTruthy();
  });

  it("a different human still cannot, by session or token", async () => {
    db.tables.deletion_requests = [tokenRaised()];
    expect((await caught(withdrawDeletion(session(BOB), "del-1"))).status).toBe(403);
    expect((await caught(withdrawDeletion(pat("tok-bob", BOB, ["task:delete:request"]), "del-1"))).status).toBe(403);
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
  });

  it("a token with no recorded owner has no human to match and cannot withdraw", async () => {
    db.tables.deletion_requests = [tokenRaised()];
    expect((await caught(withdrawDeletion(pat("tok-orphan", null, ["task:delete:request"]), "del-1"))).status).toBe(403);
  });

  it("a legacy request with no stored principal can only be withdrawn by the same actor", async () => {
    db.tables.deletion_requests = [
      deletionRow({ requested_by_type: "token", requested_by_id: "tok-alice", requested_principal_id: null }),
    ];
    expect((await caught(withdrawDeletion(session(ALICE), "del-1"))).status).toBe(403);
    await expect(withdrawDeletion(pat("tok-alice", ALICE, ["task:delete:request"]), "del-1")).resolves.toBeTruthy();
  });

  it("it still needs the maker scope for the request's type", async () => {
    db.tables.deletion_requests = [tokenRaised()];
    expect((await caught(withdrawDeletion(pat("tok-alice-3", ALICE, ["task:read"]), "del-1"))).status).toBe(403);
  });
});

describe("decideChangeRequest — the requester's notice type (P2-16)", () => {
  it("approve -> approval.approved; reject and defer -> approval.rejected", async () => {
    for (const [decision, type] of [
      ["approve", "approval.approved"],
      ["reject", "approval.rejected"],
      ["defer", "approval.rejected"],
    ] as const) {
      db.tables.change_requests = [changeRow()];
      db.tables.notifications = [];
      await decideChangeRequest(session(BOB), "cr-1", { decision, rationale: "because", expected_updated_at: V0 });
      await flush();
      expect(db.rows("notifications")).toHaveLength(1);
      expect(db.rows("notifications")[0]).toMatchObject({ recipient_id: ALICE, type });
    }
  });
});

// ── hub events carry the content version ──────────────────────────────────

describe("hub events carry the content version (a card is bound to what it shows)", () => {
  const V1 = "2026-10-16T08:00:00.000Z";

  it("a change request event is stamped with the row's updated_at", async () => {
    const ev = await changeRequestEvent(db.client as never, WS, changeRow({ updated_at: V1 }) as never);
    expect(ev.version).toBe(V1);
  });

  it("a row that carries no version yields an event with none (the hub refuses to bind a card to that)", async () => {
    expect((await changeRequestEvent(db.client as never, WS, changeRow({ updated_at: undefined }) as never)).version).toBeUndefined();
  });
});

// ── common-pattern answers (2026-10-17): Q-GOV-13/18/20/21/24, decision 20 ──────

describe("Q-GOV-21 — a rejection always carries a reason", () => {
  it("rejectDeletion without a reason is a 422 rationale_required and decides nothing", async () => {
    for (const reason of [undefined, "", "   "]) {
      const err = await caught(rejectDeletion(bobPat(), "del-1", { reason }));
      expect([err.status, err.code, err.message]).toEqual([422, "rationale_required", "Please give a reason for rejecting."]);
    }
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("decideChangeRequest: reject and defer need a reason, approve does not", async () => {
    for (const decision of ["reject", "defer"] as const) {
      const err = await caught(decideChangeRequest(session(BOB), "cr-1", { decision, rationale: " ", expected_updated_at: V0 }));
      expect([err.status, err.code]).toEqual([422, "rationale_required"]);
    }
    const out = await decideChangeRequest(session(BOB), "cr-1", { decision: "approve", expected_updated_at: V0 });
    expect(out.result.status).toBe("approved");
    expect(db.rows("change_requests")[0].decision_rationale).toBeNull();
  });

  it("decideApproval (chat) rejects with the same message and no note", async () => {
    const err = await caught(decideApproval(session(BOB), { kind: "task_deletion", id: "del-1" }, "reject"));
    expect([err.status, err.code, err.message]).toEqual([422, "rationale_required", "Please give a reason for rejecting."]);
  });
});

describe("Q-GOV-24 — a double tap on Approve", () => {
  it("the same person repeating approve gets 'done': one RPC, one set of audit rows, one notice", async () => {
    const first = await approveDeletion(bobPat(), "del-1");
    const auditAfterFirst = db.rows("audit_log").length;
    const again = await approveDeletion(bobPat(), "del-1");
    expect(first.result.status).toBe("committed");
    expect(again.result).toMatchObject({ kind: "task_deletion", id: "del-1", status: "committed" });
    expect(db.rpcCallsTo("nopm_commit_task_deletion")).toHaveLength(1);
    expect(db.rows("audit_log")).toHaveLength(auditAfterFirst);
  });

  it("a DIFFERENT person is told who decided", async () => {
    await approveDeletion(bobPat(), "del-1");
    const err = await caught(approveDeletion(pat("tok-carol", "33333333-3333-4333-8333-333333333333", APPROVE_ALL), "del-1"));
    expect([err.status, err.code]).toEqual([422, "already_decided"]);
    expect(err.message).toMatch(/^Already approved by tok-bob/);
  });

  it("the same person repeating reject gets 'done' too", async () => {
    await rejectDeletion(bobPat(), "del-1", { reason: "keep" });
    const again = await rejectDeletion(bobPat(), "del-1", { reason: "keep" });
    expect(again.result.status).toBe("rejected");
    expect(db.rows("audit_log").filter((a) => a.action === "deletion_request.rejected")).toHaveLength(1);
  });

  it("approve after a reject by the same person is NOT a repeat: already rejected", async () => {
    await rejectDeletion(bobPat(), "del-1", { reason: "keep" });
    const err = await caught(approveDeletion(bobPat(), "del-1"));
    expect([err.status, err.code]).toEqual([422, "already_decided"]);
    expect(err.message).toMatch(/^Already rejected by/);
  });

  it("a change request decided twice by the same person: second call is 'done', no second audit row", async () => {
    await decideChangeRequest(session(BOB), "cr-1", { decision: "approve", expected_updated_at: V0 });
    const audits = db.rows("audit_log").length;
    // the row's version moved with the decision; the repeat still carries the one that was read
    const again = await decideChangeRequest(session(BOB), "cr-1", { decision: "approve", expected_updated_at: V0 });
    expect(again.result.status).toBe("approved");
    expect(db.rows("audit_log")).toHaveLength(audits);
  });

  it("a change request decided by someone else names them", async () => {
    await decideChangeRequest(session(BOB), "cr-1", { decision: "approve", expected_updated_at: V0 });
    db.tables.profiles.push({ id: "33333333-3333-4333-8333-333333333333", workspace_id: WS, role: "manager" });
    const carol = session("33333333-3333-4333-8333-333333333333", { label: "Carol" });
    const err = await caught(decideChangeRequest(carol, "cr-1", { decision: "approve", expected_updated_at: V0 }));
    expect([err.status, err.code]).toEqual([422, "already_decided"]);
    expect(err.message).toBe("Already approved by Bob.");
  });
});

describe("Q-GOV-18 / Q-GOV-20 — a request that can no longer succeed is closed with its own label", () => {
  it("record already gone: closed with closed_reason target_gone and the plain message", async () => {
    db.tables.tasks = [];
    const err = await caught(approveDeletion(bobPat(), "del-1"));
    expect(err.message).toBe("This record was already deleted, so the request is closed.");
    expect(db.rows("deletion_requests")[0]).toMatchObject({ status: "withdrawn", closed_reason: "target_gone" });
    expect(db.rows("audit_log")[0].after).toMatchObject({ status: "withdrawn", reason: "target_gone" });
  });

  it("project locked after the request: the request is auto-closed (audited) and the message says how to continue", async () => {
    db.rpcHandlers.nopm_commit_task_deletion = () => ({ data: null, error: { code: "P0010", message: "PROJECT_LOCKED: frozen" } });
    const err = await caught(approveDeletion(bobPat(), "del-1"));
    expect([err.status, err.code, err.message]).toEqual([
      422,
      "project_locked",
      "Closed: the project was locked after this was requested. Raise it again if still needed.",
    ]);
    expect(db.rows("deletion_requests")[0]).toMatchObject({ status: "withdrawn", closed_reason: "project_locked" });
    expect(db.rows("audit_log").map((a) => [a.action, (a.after as { reason?: string }).reason])).toEqual([
      ["deletion_request.withdrawn", "project_locked"],
    ]);
  });

  it("a second approve on the closed request is simply 'already withdrawn'", async () => {
    db.rpcHandlers.nopm_commit_task_deletion = () => ({ data: null, error: { code: "P0010", message: "PROJECT_LOCKED" } });
    await caught(approveDeletion(bobPat(), "del-1"));
    const err = await caught(approveDeletion(bobPat(), "del-1"));
    expect([err.status, err.code, err.message]).toEqual([422, "already_decided", "Already withdrawn."]);
  });
});

describe("decision 20 — deleting a project", () => {
  const projectRequest = () =>
    deletionRow({ target_type: "project", target_id: "proj-1", before: { id: "proj-1", name: "Billing Migration" } });

  it("P0022 (approved change requests / rebaselines) -> 422 project_has_approved_records, request stays pending", async () => {
    db.tables.deletion_requests = [projectRequest()];
    db.rpcHandlers.nopm_commit_project_deletion = () => ({
      data: null,
      error: { code: "P0022", message: "PROJECT_HAS_APPROVED_RECORDS: 1 approved change request(s)" },
    });
    const err = await caught(approveDeletion(bobPat(), "del-1"));
    expect([err.status, err.code]).toEqual([422, "project_has_approved_records"]);
    expect(err.message).toMatch(/approved change requests or approved rebaselines/);
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
  });

  it("the paths the commit RPC returned are handed to the file remover, for this workspace, after the commit", async () => {
    db.tables.deletion_requests = [projectRequest()];
    const paths = [`${WS}/doc-1/a.pdf`];
    db.rpcHandlers.nopm_commit_project_deletion = () => ({ data: { committed: true, document_paths: paths }, error: null });
    const out = await approveDeletion(bobPat(), "del-1");
    expect(out.result.status).toBe("committed");
    expect(storageRemoved.calls).toEqual([[paths, WS]]);
  });

  it("a TASK deletion removes no files", async () => {
    await approveDeletion(bobPat(), "del-1");
    expect(storageRemoved.calls).toEqual([]);
  });
});

describe("Q-WRK-27 — a status drag does not void a pending task deletion", () => {
  const withVersions = (before: Record<string, unknown>, live: Record<string, unknown>) => {
    db.tables.deletion_requests = [deletionRow({ before: { id: "task-1", name: "Migrate billing DB", project_id: "proj-1", ...before } })];
    Object.assign(db.rows("tasks")[0], live);
  };

  it("content_updated_at unchanged while updated_at moved (status drag) -> still approvable", async () => {
    withVersions(
      { updated_at: "2026-10-01T00:00:00Z", content_updated_at: "2026-09-01T00:00:00Z" },
      { updated_at: "2026-10-05T00:00:00Z", content_updated_at: "2026-09-01T00:00:00Z" },
    );
    expect((await approveDeletion(bobPat(), "del-1")).result.status).toBe("committed");
  });

  it("content_updated_at moved (name, dates or assignee changed) -> 422 target_changed", async () => {
    withVersions(
      { updated_at: "2026-10-01T00:00:00Z", content_updated_at: "2026-09-01T00:00:00Z" },
      { updated_at: "2026-10-05T00:00:00Z", content_updated_at: "2026-10-05T00:00:00Z" },
    );
    const err = await caught(approveDeletion(bobPat(), "del-1"));
    expect([err.status, err.code]).toEqual([422, "target_changed"]);
  });

  it("a request raised before content_updated_at existed falls back to updated_at", async () => {
    withVersions({ updated_at: "2026-10-01T00:00:00Z" }, { updated_at: "2026-10-05T00:00:00Z", content_updated_at: "2026-09-01T00:00:00Z" });
    const err = await caught(approveDeletion(bobPat(), "del-1"));
    expect(err.code).toBe("target_changed");
  });
});
