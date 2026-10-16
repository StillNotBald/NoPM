import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/governance/decide", () => ({ decideApproval: decideMock }));

import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { handleApprovalAction, mapDecisionError, type ApprovalActionInput } from "./inbound";
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
