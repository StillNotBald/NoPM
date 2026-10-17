import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { decideMock, changeEventMock, timesheetEventMock, runChangedMock, scheduled } = vi.hoisted(() => ({
  decideMock: vi.fn(),
  changeEventMock: vi.fn(),
  timesheetEventMock: vi.fn(),
  runChangedMock: vi.fn(async () => {}),
  scheduled: [] as { label: string; workspaceId: string; task: () => Promise<unknown> }[],
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/governance/decide", () => ({
  decideApproval: decideMock,
  changeRequestEvent: changeEventMock,
  timesheetEvent: timesheetEventMock,
}));
// The edit path is exercised for real in emit.test.ts; here it is observed.
vi.mock("@/lib/integrations/emit", () => ({
  schedule: (label: string, workspaceId: string, task: () => Promise<unknown>) => {
    scheduled.push({ label, workspaceId, task });
  },
  runApprovalChanged: runChangedMock,
}));

import { NotFoundError, PreconditionFailedError, RuleError, ScopeError } from "@/lib/api/errors";
import { handleApprovalAction, mapDecisionError, reissueAfterChange, type ApprovalActionInput } from "./inbound";
import {
  CONNECTOR_ID,
  FakeDb,
  OTHER_WS,
  TEST_ENCRYPTION_KEY,
  WS,
  ids,
  linkIdentity,
  seedWorkspace,
} from "./test-support";
import type { ConnectorRow } from "./types";

const T0 = new Date("2026-10-16T09:00:00.000Z");
const RAW_TOKEN = "npa_raw-token-for-max-0123456789";
const OTHER_RAW_TOKEN = "npa_raw-token-for-mia-9876543210";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

let db: FakeDb;
let connector: ConnectorRow;

function issueToken(raw: string, recipient: string, over: Record<string, unknown> = {}) {
  db.seed("action_tokens", [
    {
      id: `tok-${raw.slice(-4)}`,
      workspace_id: WS,
      delivery_id: "delivery-1",
      recipient_profile_id: recipient,
      approval_kind: "task_deletion",
      approval_id: ids.approval,
      token_hash: sha(raw),
      expires_at: new Date(T0.getTime() + 7 * 24 * 3600_000).toISOString(),
      used_at: null,
      ...over,
    },
  ]);
}

const token = (raw: string) => db.rows("action_tokens").find((t) => t.token_hash === sha(raw))!;
const claims = () => db.rows("inbound_actions");

function input(over: Partial<ApprovalActionInput> = {}): ApprovalActionInput {
  return {
    connector,
    externalEventId: "evt-1",
    externalTenant: "tenant-1",
    externalUserId: "ou_max",
    actionToken: RAW_TOKEN,
    action: "approve",
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  decideMock.mockReset();
  decideMock.mockResolvedValue({
    kind: "task_deletion",
    id: ids.approval,
    status: "committed",
    title: 'Delete task "Migrate billing DB"',
    requesterPrincipalId: ids.requester,
  });
  db = new FakeDb();
  state.db = db;
  connector = seedWorkspace(db);
  linkIdentity(db, ids.manager, "ou_max");
  linkIdentity(db, ids.manager2, "ou_mia");
  issueToken(RAW_TOKEN, ids.manager);
  issueToken(OTHER_RAW_TOKEN, ids.manager2);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("handleApprovalAction — the happy path", () => {
  it("decides through decideApproval as the VERIFIED linked human, with channel lark and connector provenance", async () => {
    const out = await handleApprovalAction(input({ externalEventId: "evt-happy" }));

    expect(out).toEqual({
      status: "decided",
      action: "approve",
      ref: { kind: "task_deletion", id: ids.approval },
      title: 'Delete task "Migrate billing DB"',
      newStatus: "committed",
    });
    expect(decideMock).toHaveBeenCalledTimes(1);
    const [actor, ref, action, note] = decideMock.mock.calls[0];
    expect(actor).toMatchObject({
      type: "user",
      id: ids.manager,
      principalId: ids.manager, // four-eyes compares the HUMAN
      label: "Max Manager",
      workspaceId: WS,
      role: "manager",
      channel: "lark", // server-derived, never from a header
      viaConnectorId: CONNECTOR_ID,
      externalEventId: "evt-happy",
      externalActorRef: "lark:tenant-1:ou_max",
    });
    expect(typeof actor.requestId).toBe("string");
    expect(ref).toEqual({ kind: "task_deletion", id: ids.approval }); // from the token row, not from the click
    expect(action).toBe("approve");
    expect(note).toBeUndefined();
  });

  it("records the outcome, principal and approval on the idempotency ledger and burns the token", async () => {
    await handleApprovalAction(input({ externalEventId: "evt-ledger" }));
    expect(claims()).toHaveLength(1);
    expect(claims()[0]).toMatchObject({
      workspace_id: WS,
      connector_id: CONNECTOR_ID,
      external_event_id: "evt-ledger",
      action: "approve",
      principal_id: ids.manager,
      approval_kind: "task_deletion",
      approval_id: ids.approval,
    });
    expect((claims()[0].outcome as { status: string }).status).toBe("decided");
    expect(token(RAW_TOKEN).used_at).not.toBeNull();
  });

  it("passes the (trimmed) reason through on reject", async () => {
    await handleApprovalAction(input({ action: "reject", note: "  Not now, budget frozen.  " }));
    expect(decideMock.mock.calls[0][2]).toBe("reject");
    expect(decideMock.mock.calls[0][3]).toBe("Not now, budget frozen.");
  });
});

describe("idempotency", () => {
  it("a replay of the same event id returns the stored outcome with NO second mutation", async () => {
    const first = await handleApprovalAction(input({ externalEventId: "evt-replay" }));
    const second = await handleApprovalAction(input({ externalEventId: "evt-replay" }));
    const third = await handleApprovalAction(input({ externalEventId: "evt-replay", action: "reject", note: "changed my mind" }));

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(decideMock).toHaveBeenCalledTimes(1);
    expect(claims()).toHaveLength(1);
  });

  it("replays stored refusals too (a self-approval stays a self-approval)", async () => {
    decideMock.mockRejectedValueOnce(new ScopeError("Self-approval is not allowed (four-eyes)"));
    const first = await handleApprovalAction(input({ externalEventId: "evt-self" }));
    const again = await handleApprovalAction(input({ externalEventId: "evt-self" }));
    expect(first).toEqual({ status: "self_approval" });
    expect(again).toEqual(first);
    expect(decideMock).toHaveBeenCalledTimes(1);
  });

  it("an in-flight duplicate (claim without outcome) is told it is already being processed", async () => {
    db.seed("inbound_actions", [
      { id: "c1", workspace_id: WS, connector_id: CONNECTOR_ID, external_event_id: "evt-busy", action: "approve", outcome: null, received_at: new Date().toISOString() },
    ]);
    const out = await handleApprovalAction(input({ externalEventId: "evt-busy" }));
    expect(out).toMatchObject({ status: "error", message: expect.stringMatching(/already being processed/) });
    expect(decideMock).not.toHaveBeenCalled();
    expect(token(RAW_TOKEN).used_at).toBeNull();
  });

  it("a stale claim from a crashed run is retaken", async () => {
    db.seed("inbound_actions", [
      { id: "c1", workspace_id: WS, connector_id: CONNECTOR_ID, external_event_id: "evt-stale", action: "approve", outcome: null, received_at: new Date(Date.now() - 5 * 60_000).toISOString() },
    ]);
    const out = await handleApprovalAction(input({ externalEventId: "evt-stale" }));
    expect(out.status).toBe("decided");
    expect(decideMock).toHaveBeenCalledTimes(1);
  });
});

describe("action token — single use, recipient-bound, approval-bound", () => {
  it("cannot be used twice (a second click with a new event id is already_decided)", async () => {
    expect((await handleApprovalAction(input({ externalEventId: "evt-a" }))).status).toBe("decided");
    expect(await handleApprovalAction(input({ externalEventId: "evt-b" }))).toEqual({ status: "already_decided" });
    expect(decideMock).toHaveBeenCalledTimes(1);
  });

  it("is atomic: of two simultaneous clicks exactly one decides", async () => {
    const [a, b] = await Promise.all([
      handleApprovalAction(input({ externalEventId: "evt-race-1" })),
      handleApprovalAction(input({ externalEventId: "evt-race-2" })),
    ]);
    expect([a.status, b.status].sort()).toEqual(["already_decided", "decided"]);
    expect(decideMock).toHaveBeenCalledTimes(1);
  });

  it("is bound to its recipient: another linked approver using it gets not_recipient and the token survives", async () => {
    const out = await handleApprovalAction(input({ externalUserId: "ou_mia", externalEventId: "evt-steal" }));
    expect(out).toEqual({ status: "not_recipient" });
    expect(decideMock).not.toHaveBeenCalled();
    expect(token(RAW_TOKEN).used_at).toBeNull();

    // the rightful recipient can still use it
    expect((await handleApprovalAction(input({ externalEventId: "evt-owner" }))).status).toBe("decided");
  });

  it("rejects an expired token", async () => {
    token(RAW_TOKEN).expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await handleApprovalAction(input())).toEqual({ status: "expired" });
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown / forged token without touching anything", async () => {
    const out = await handleApprovalAction(input({ actionToken: "npa_forged" }));
    expect(out.status).toBe("invalid");
    expect(decideMock).not.toHaveBeenCalled();
    expect(db.rows("action_tokens").every((t) => t.used_at === null)).toBe(true);
  });

  it("a token superseded by a decision from another channel reads as already_decided", async () => {
    token(RAW_TOKEN).used_at = new Date(Date.now() - 60_000).toISOString();
    expect(await handleApprovalAction(input())).toEqual({ status: "already_decided" });
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("never honours a token from another workspace", async () => {
    token(RAW_TOKEN).workspace_id = OTHER_WS;
    expect((await handleApprovalAction(input())).status).toBe("invalid");
    expect(decideMock).not.toHaveBeenCalled();
  });
});

describe("identity", () => {
  it("unlinked platform user -> unlinked, nothing consumed", async () => {
    expect(await handleApprovalAction(input({ externalUserId: "ou_stranger" }))).toEqual({ status: "unlinked" });
    expect(decideMock).not.toHaveBeenCalled();
    expect(token(RAW_TOKEN).used_at).toBeNull();
  });

  it("the tenant is part of the identity", async () => {
    expect((await handleApprovalAction(input({ externalTenant: "tenant-OTHER" }))).status).toBe("unlinked");
  });

  it("a revoked link no longer authorises anything, even with a valid token", async () => {
    db.rows("external_identities").find((r) => r.external_user_id === "ou_max")!.revoked_at = "2026-10-15T00:00:00.000Z";
    expect(await handleApprovalAction(input())).toEqual({ status: "unlinked" });
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("an identity whose profile is gone or in another workspace is unlinked", async () => {
    db.rows("profiles").find((p) => p.id === ids.manager)!.workspace_id = OTHER_WS;
    expect((await handleApprovalAction(input())).status).toBe("unlinked");
  });

  it("a person demoted below manager since the card was sent can no longer approve from it", async () => {
    db.rows("profiles").find((p) => p.id === ids.manager)!.role = "member";
    const out = await handleApprovalAction(input());
    expect(out.status).toBe("forbidden");
    expect(decideMock).not.toHaveBeenCalled();
    expect(token(RAW_TOKEN).used_at).toBeNull();
  });
});

describe("kill switch and input validation", () => {
  it("a paused connector refuses in both directions: no claim, no token use, no decision", async () => {
    const out = await handleApprovalAction(input({ connector: { ...connector, status: "paused" } }));
    expect(out).toMatchObject({ status: "forbidden", message: expect.stringMatching(/paused/) });
    expect(claims()).toHaveLength(0);
    expect(token(RAW_TOKEN).used_at).toBeNull();
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("requires a reason to reject, before anything is consumed", async () => {
    for (const note of [undefined, null, "", "   "]) {
      const out = await handleApprovalAction(input({ action: "reject", note }));
      expect(out).toMatchObject({ status: "invalid", message: expect.stringMatching(/reason/i) });
    }
    expect(claims()).toHaveLength(0);
    expect(token(RAW_TOKEN).used_at).toBeNull();
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("rejects a missing event id / token / unknown action", async () => {
    expect((await handleApprovalAction(input({ externalEventId: "" }))).status).toBe("invalid");
    expect((await handleApprovalAction(input({ actionToken: " " }))).status).toBe("invalid");
    expect((await handleApprovalAction(input({ action: "delete" as unknown as "approve" }))).status).toBe("invalid");
    expect(decideMock).not.toHaveBeenCalled();
  });
});

describe("governance outcomes (decideApproval errors -> typed outcomes)", () => {
  it("self-approval (four-eyes) -> self_approval, and the card is spent", async () => {
    decideMock.mockRejectedValueOnce(new ScopeError("Self-approval is not allowed (four-eyes)"));
    expect(await handleApprovalAction(input())).toEqual({ status: "self_approval" });
    expect(token(RAW_TOKEN).used_at).not.toBeNull();
  });

  it("branches on the governed error code first (self_approval, already_decided, rationale_required, no_principal)", () => {
    expect(mapDecisionError(new ScopeError("anything", "self_approval"))).toEqual({ status: "self_approval" });
    expect(mapDecisionError(new RuleError("anything", "already_decided"))).toEqual({ status: "already_decided" });
    expect(mapDecisionError(new RuleError("anything", "rationale_required"))).toMatchObject({
      status: "invalid",
      message: expect.stringMatching(/reason/i),
    });
    // a missing principal is a refusal with its own message, not a self-approval
    expect(mapDecisionError(new ScopeError("This token has no recorded owner (four-eyes)", "no_principal"))).toEqual({
      status: "forbidden",
      message: "This token has no recorded owner (four-eyes)",
    });
  });

  it("falls back to the message for governed errors thrown without a code", () => {
    expect(mapDecisionError(new ScopeError("Self-approval is not allowed (four-eyes)", "forbidden_scope"))).toEqual({
      status: "self_approval",
    });
  });

  it("missing scope / role -> forbidden with the message", async () => {
    decideMock.mockRejectedValueOnce(new ScopeError("Viewers have read-only access"));
    expect(await handleApprovalAction(input())).toEqual({ status: "forbidden", message: "Viewers have read-only access" });
  });

  it("already decided -> already_decided", async () => {
    decideMock.mockRejectedValueOnce(new RuleError("Request already decided"));
    expect(await handleApprovalAction(input())).toEqual({ status: "already_decided" });
  });

  it("a rule failure (locked project) -> invalid with the message, and the card is NOT burned", async () => {
    decideMock.mockRejectedValueOnce(new RuleError("Project is locked — unlock or rebaseline before committing this deletion."));
    const out = await handleApprovalAction(input({ externalEventId: "evt-locked" }));
    expect(out).toMatchObject({ status: "invalid", message: expect.stringMatching(/locked/) });
    expect(token(RAW_TOKEN).used_at).toBeNull();
    // after the lock is lifted the same card works with a new click
    expect((await handleApprovalAction(input({ externalEventId: "evt-unlocked" }))).status).toBe("decided");
  });

  it("request no longer exists -> invalid", async () => {
    decideMock.mockRejectedValueOnce(new NotFoundError("Deletion request not found"));
    expect(await handleApprovalAction(input())).toMatchObject({ status: "invalid", message: expect.stringMatching(/no longer exists/) });
  });

  it("an unexpected failure -> error, the card is released and the claim dropped so the platform's retry can succeed", async () => {
    decideMock.mockRejectedValueOnce(new Error("connection reset"));
    const first = await handleApprovalAction(input({ externalEventId: "evt-flaky" }));
    expect(first.status).toBe("error");
    expect(token(RAW_TOKEN).used_at).toBeNull();
    expect(claims()).toHaveLength(0);

    const retry = await handleApprovalAction(input({ externalEventId: "evt-flaky" }));
    expect(retry.status).toBe("decided");
    expect(decideMock).toHaveBeenCalledTimes(2);
  });

  it("an error message never leaks the underlying exception text", async () => {
    decideMock.mockRejectedValueOnce(new Error("password=hunter2 at db.internal:5432"));
    const out = await handleApprovalAction(input());
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });
});

describe("never throws to the platform", () => {
  it("returns a typed error when the database is down", async () => {
    db.failNext({ table: "inbound_actions", op: "insert", error: { message: "db down" } });
    await expect(handleApprovalAction(input())).resolves.toMatchObject({ status: "error" });

    db.failNext({ table: "external_identities", op: "select", error: { message: "db down" } });
    await expect(handleApprovalAction(input({ externalEventId: "evt-2" }))).resolves.toMatchObject({ status: "error" });
    // a failure mid-pipeline leaves nothing half-consumed
    expect(token(RAW_TOKEN).used_at).toBeNull();
    expect(claims().filter((c) => c.outcome == null)).toHaveLength(0);
  });
});

describe("mapDecisionError", () => {
  it.each([
    [new ScopeError("Self-approval is not allowed (four-eyes)"), "self_approval"],
    [new ScopeError("API token is missing required scope: task:delete:approve"), "forbidden"],
    [new RuleError("Request already decided"), "already_decided"],
    [new RuleError("Change request already decided (status: approved)"), "already_decided"],
    [new RuleError("A reason is required"), "invalid"],
    [new NotFoundError("nope"), "invalid"],
    [new Error("boom"), "error"],
  ])("%s -> %s", (err, status) => {
    expect(mapDecisionError(err).status).toBe(status);
  });
});

describe("tenant pin", () => {
  const MESSAGE = "This Lark workspace is not the one connected to NoPM";

  it("refuses a card click from any other Lark tenant before touching the ledger, the token or the decision", async () => {
    const pinnedConnector = { ...connector, tenant_key: "tenant-1" };
    const out = await handleApprovalAction(input({ connector: pinnedConnector, externalTenant: "tenant-EVIL", externalEventId: "evt-tenant" }));

    expect(out).toEqual({ status: "forbidden", message: MESSAGE });
    expect(claims()).toHaveLength(0);
    expect(token(RAW_TOKEN).used_at).toBeNull();
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("an identity row with the right open_id but a foreign tenant is refused too, even if a stale connector row lacks the pin", async () => {
    // unpinned connector object, foreign tenant => no identity matches that tenant
    expect((await handleApprovalAction(input({ externalTenant: "tenant-EVIL" }))).status).toBe("unlinked");
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("works normally for the pinned tenant", async () => {
    const pinnedConnector = { ...connector, tenant_key: "tenant-1" };
    const out = await handleApprovalAction(input({ connector: pinnedConnector }));
    expect(out.status).toBe("decided");
    expect(decideMock).toHaveBeenCalledTimes(1);
  });
});

describe("handleApprovalAction — approve what you saw (content-version binding)", () => {
  const V1 = "2026-10-16T08:00:00.000Z"; // what the seeded change request starts at
  const V2 = "2026-10-16T11:45:00.000Z";
  const CR_TOKEN = "npa_raw-token-for-cr-0000000001";
  const crRow = () => db.rows("change_requests")[0];
  const crDecision = {
    kind: "change_request",
    id: ids.approval,
    status: "approved",
    title: "Change request CR-7: rename a label",
    requesterPrincipalId: ids.requester,
  };

  function issueCrToken(version: string | null = V1, over: Record<string, unknown> = {}) {
    issueToken(CR_TOKEN, ids.manager, { approval_kind: "change_request", approval_version: version, ...over });
  }

  beforeEach(() => {
    decideMock.mockResolvedValue(crDecision);
    scheduled.length = 0;
    runChangedMock.mockReset();
  });

  it("decides when the request is still at the version the card was issued for, and PINS the decision write to it", async () => {
    issueCrToken();
    const out = await handleApprovalAction(input({ actionToken: CR_TOKEN, externalEventId: "evt-ver-ok" }));

    expect(out.status).toBe("decided");
    expect(decideMock).toHaveBeenCalledTimes(1);
    const [, ref, action, note, opts] = decideMock.mock.calls[0];
    expect(ref).toEqual({ kind: "change_request", id: ids.approval });
    expect(action).toBe("approve");
    expect(note).toBeUndefined();
    expect(opts).toEqual({ expectedUpdatedAt: V1 });
  });

  it("REFUSES a tap on a card whose request was edited since: nothing is decided, the request stays pending", async () => {
    issueCrToken();
    crRow().updated_at = V2; // the requester edited it after the card went out

    const out = await handleApprovalAction(input({ actionToken: CR_TOKEN, externalEventId: "evt-stale" }));

    expect(out).toEqual({ status: "changed" });
    expect(decideMock).not.toHaveBeenCalled();
    expect(crRow().status).toBe("raised");
    // the spent token is marked as retired-by-edit, and the outcome is on the ledger
    expect(token(CR_TOKEN)).toMatchObject({ superseded_reason: "changed" });
    expect(token(CR_TOKEN).used_at).not.toBeNull();
    expect(claims().find((c) => c.external_event_id === "evt-stale")?.outcome).toEqual({ status: "changed" });
  });

  it("answers a repeat tap, and a replay of the same event, with the same 'changed' (never 'already decided')", async () => {
    issueCrToken();
    crRow().updated_at = V2;
    await handleApprovalAction(input({ actionToken: CR_TOKEN, externalEventId: "evt-stale-1" }));

    expect(await handleApprovalAction(input({ actionToken: CR_TOKEN, externalEventId: "evt-stale-2" }))).toEqual({ status: "changed" });
    expect(await handleApprovalAction(input({ actionToken: CR_TOKEN, externalEventId: "evt-stale-1" }))).toEqual({ status: "changed" });
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("re-issues fresh cards in the background, so a harmless bump is never a dead end", async () => {
    issueCrToken();
    crRow().updated_at = V2;
    await handleApprovalAction(input({ actionToken: CR_TOKEN, externalEventId: "evt-stale-3" }));

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].workspaceId).toBe(WS);
    changeEventMock.mockResolvedValueOnce({ workspaceId: WS, kind: "change_request", id: ids.approval, title: "CR-7 as it reads now" });
    await scheduled[0].task();
    expect(runChangedMock).toHaveBeenCalledWith(expect.objectContaining({ id: ids.approval, title: "CR-7 as it reads now", version: V2 }));
  });

  it("treats a 412 from the decision write (an edit landed after the check) as 'changed' too", async () => {
    issueCrToken();
    decideMock.mockRejectedValueOnce(new PreconditionFailedError("Record changed since you loaded it"));

    const out = await handleApprovalAction(input({ actionToken: CR_TOKEN, externalEventId: "evt-412" }));

    expect(out).toEqual({ status: "changed" });
    expect(token(CR_TOKEN)).toMatchObject({ superseded_reason: "changed" });
    expect(token(CR_TOKEN).used_at).not.toBeNull(); // the old card cannot be retried
    expect(scheduled).toHaveLength(1);
  });

  it("leaves a request that is already decided to the decision code (it answers precisely)", async () => {
    issueCrToken();
    Object.assign(crRow(), { status: "approved", updated_at: V2 });
    decideMock.mockRejectedValueOnce(new RuleError("Change request already decided (status: approved)", "already_decided"));

    const out = await handleApprovalAction(input({ actionToken: CR_TOKEN, externalEventId: "evt-decided" }));

    expect(out).toEqual({ status: "already_decided" });
    expect(scheduled).toHaveLength(0);
  });

  it("checks nothing for a token with no version (a deletion request, or a card from before versioning) and pins nothing", async () => {
    const out = await handleApprovalAction(input({ externalEventId: "evt-noversion" })); // the seeded task_deletion token
    expect(out.status).toBe("decided");
    expect(decideMock.mock.calls[0][4]).toEqual({});
  });

  it("works the same for a timesheet submission's version", async () => {
    issueToken(CR_TOKEN, ids.manager, { approval_kind: "timesheet", approval_version: V1 });
    db.rows("timesheet_submissions")[0].updated_at = V2;
    expect(await handleApprovalAction(input({ actionToken: CR_TOKEN, externalEventId: "evt-ts" }))).toEqual({ status: "changed" });
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("a different recipient's stale token is still 'not sent to you', not a hint about the request", async () => {
    issueCrToken();
    crRow().updated_at = V2;
    const out = await handleApprovalAction(
      input({ actionToken: CR_TOKEN, externalUserId: "ou_mia", externalEventId: "evt-wrong-person" }),
    );
    expect(out).toEqual({ status: "not_recipient" });
  });

  it("a request in another workspace with the same id does not satisfy the version check", async () => {
    issueCrToken();
    db.rows("change_requests")[0].workspace_id = OTHER_WS; // the request is not in this workspace at all
    const out = await handleApprovalAction(input({ actionToken: CR_TOKEN, externalEventId: "evt-foreign" }));
    // not "pending in this workspace": left to the decision code, which finds nothing
    expect(out.status).not.toBe("changed");
  });
});

describe("mapDecisionError — a 412 is a change", () => {
  it("maps PreconditionFailedError to changed", () => {
    expect(mapDecisionError(new PreconditionFailedError())).toEqual({ status: "changed" });
  });
});

describe("reissueAfterChange", () => {
  const V2 = "2026-10-16T11:45:00.000Z";

  beforeEach(() => runChangedMock.mockReset());

  it("builds the change request's event as it reads NOW and runs the edit path with its version", async () => {
    db.rows("change_requests")[0].updated_at = V2;
    changeEventMock.mockResolvedValueOnce({ workspaceId: WS, kind: "change_request", id: ids.approval, title: "CR-7 now" });
    await reissueAfterChange(WS, { kind: "change_request", id: ids.approval });
    expect(runChangedMock).toHaveBeenCalledWith({ workspaceId: WS, kind: "change_request", id: ids.approval, title: "CR-7 now", version: V2 });
  });

  it("builds a pending timesheet's event the same way", async () => {
    db.rows("timesheet_submissions")[0].updated_at = V2;
    timesheetEventMock.mockResolvedValueOnce({ workspaceId: WS, kind: "timesheet", id: ids.approval, title: "Timesheet now" });
    await reissueAfterChange(WS, { kind: "timesheet", id: ids.approval });
    expect(runChangedMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "timesheet", version: V2 }));
  });

  it("does nothing for a request that is no longer pending, is missing, or has no version (a deletion)", async () => {
    db.rows("change_requests")[0].status = "approved";
    await reissueAfterChange(WS, { kind: "change_request", id: ids.approval });
    db.tables.timesheet_submissions = [];
    await reissueAfterChange(WS, { kind: "timesheet", id: ids.approval });
    await reissueAfterChange(WS, { kind: "task_deletion", id: ids.approval });
    expect(runChangedMock).not.toHaveBeenCalled();
  });

  it("is workspace-scoped", async () => {
    await reissueAfterChange(OTHER_WS, { kind: "change_request", id: ids.approval });
    expect(runChangedMock).not.toHaveBeenCalled();
  });
});
