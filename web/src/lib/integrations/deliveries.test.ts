import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
// The real adapter is W3b's; the hub core must work with ANY registered adapter.
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));

import {
  ACTION_TOKEN_PREFIX,
  ACTION_TOKEN_TTL_MS,
  DEFAULT_DRAIN_LIMIT,
  DuplicateDeliveryError,
  ID_BATCH,
  LEASE_MS,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  OPPORTUNISTIC_RETRY_BATCH,
  clearAdapters,
  drainDeliveries,
  drainDueRetries,
  enqueueBotReply,
  enqueueDigest,
  insertDeliveries,
  isVersionedKind,
  planAfterFailure,
  registerAdapter,
  sameVersion,
  setChangedFollowUp,
} from "./deliveries";
import {
  APP_SECRET,
  CONNECTOR_ID,
  FakeDb,
  OTHER_WS,
  TEST_ENCRYPTION_KEY,
  WS,
  connectorRow,
  createFakeAdapter,
  ids,
  seedWorkspace,
} from "./test-support";
import { deriveActionToken } from "./secrets";
import type { ApprovalDecidedEvent, ApprovalEvent, DigestData } from "./types";

const T0 = new Date("2026-10-16T09:00:00.000Z");
const MIN = 60_000;

let db: FakeDb;
let fake: ReturnType<typeof createFakeAdapter>;

const event: ApprovalEvent = {
  workspaceId: WS,
  kind: "change_request",
  id: ids.approval,
  title: "Add scope: SSO",
  summary: "Customer ask",
  projectId: null,
  projectName: "Apollo",
  requestedByLabel: "Rae Requester",
  requesterPrincipalId: ids.requester,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pm.example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  fake = createFakeAdapter();
  clearAdapters();
  registerAdapter(fake.adapter);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function queueCard(over: Record<string, unknown> = {}) {
  const [row] = await insertDeliveries(WS, CONNECTOR_ID, [
    {
      kind: "approval_card",
      approval_kind: "change_request",
      approval_id: ids.approval,
      recipient_profile_id: ids.manager,
      external_target: "ou_max",
      payload: { event },
      ...over,
    },
  ]);
  return row;
}

const drain = (extra: Partial<Parameters<typeof drainDeliveries>[0]> = {}) =>
  drainDeliveries({ workspaceId: WS, now: new Date(), ...extra });

const row = (id: string) => db.rows("integration_deliveries").find((r) => r.id === id) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("retry schedule", () => {
  it("retries after 1m, 5m, 30m, 2h, 12h, then goes dead", () => {
    expect(RETRY_DELAYS_MS).toEqual([1 * MIN, 5 * MIN, 30 * MIN, 120 * MIN, 720 * MIN]);
    expect(MAX_ATTEMPTS).toBe(6);
    const delays: number[] = [];
    for (let n = 1; n <= 5; n++) {
      const plan = planAfterFailure(n, true, T0);
      if (plan.status !== "retry") throw new Error("expected retry");
      delays.push(plan.nextAttemptAt.getTime() - T0.getTime());
    }
    expect(delays).toEqual([...RETRY_DELAYS_MS]);
    expect(planAfterFailure(6, true, T0)).toEqual({ status: "dead" });
  });

  it("a non-retryable failure is dead immediately", () => {
    expect(planAfterFailure(1, false, T0)).toEqual({ status: "dead" });
  });
});

describe("drainDeliveries — approval cards", () => {
  it("renders with a freshly minted single-use token, sends a DM, and never persists the raw token", async () => {
    const queued = await queueCard();

    const summary = await drain();

    expect(summary).toMatchObject({ claimed: 1, sent: 1, retried: 0, dead: 0 });
    expect(fake.calls.sends).toHaveLength(1);
    expect(fake.calls.sends[0]).toMatchObject({ receiveIdType: "open_id", receiveId: "ou_max" });
    const { actionToken, appUrl } = fake.calls.cards[0].ctx;
    expect(actionToken).toMatch(/^npa_[A-Za-z0-9_-]{32}$/);
    expect(appUrl).toBe("https://pm.example.test");

    const token = db.rows("action_tokens")[0];
    expect(token).toMatchObject({
      workspace_id: WS,
      delivery_id: queued.id,
      recipient_profile_id: ids.manager,
      approval_kind: "change_request",
      approval_id: ids.approval,
      used_at: null,
      token_hash: createHash("sha256").update(actionToken).digest("hex"),
    });
    expect(new Date(token.expires_at as string).getTime() - T0.getTime()).toBe(ACTION_TOKEN_TTL_MS);
    // the raw token exists in the card only
    expect(JSON.stringify(db.tables)).not.toContain(actionToken);

    expect(row(queued.id)).toMatchObject({ status: "sent", attempts: 1, external_message_id: "om_1", last_error: null });
    expect(row(queued.id).locked_until).toBeNull();
  });

  it("walks the retry schedule on repeated failure and ends dead after the sixth failed attempt", async () => {
    fake.state.sendResult = async () => ({ ok: false, retryable: true, error: "429 rate limited" });
    const queued = await queueCard();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const s = await drain();
      expect(s.claimed).toBe(1);
      if (attempt < MAX_ATTEMPTS) {
        expect(row(queued.id)).toMatchObject({ status: "retry", attempts: attempt, last_error: "429 rate limited" });
        const due = new Date(row(queued.id).next_attempt_at).getTime();
        expect(due - Date.now()).toBe(RETRY_DELAYS_MS[attempt - 1]);
        // not due yet => untouched
        expect((await drain()).claimed).toBe(0);
        vi.setSystemTime(new Date(due));
      }
    }
    expect(row(queued.id)).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS });
    // dead rows are never picked up again
    vi.setSystemTime(new Date(Date.now() + 24 * 60 * MIN));
    expect((await drain()).claimed).toBe(0);
    expect(fake.calls.sends).toHaveLength(MAX_ATTEMPTS);
  });

  it("goes dead immediately on a non-retryable adapter failure", async () => {
    fake.state.sendResult = async () => ({ ok: false, retryable: false, error: "invalid receive_id" });
    const queued = await queueCard();
    const s = await drain();
    expect(s).toMatchObject({ dead: 1, retried: 0 });
    expect(row(queued.id)).toMatchObject({ status: "dead", attempts: 1, last_error: "invalid receive_id" });
  });

  it("stores a truncated last_error that never contains a secret", async () => {
    fake.state.sendResult = async () => ({
      ok: false,
      retryable: true,
      error: `auth failed for ${APP_SECRET}: ${"boom ".repeat(200)}`,
    });
    const queued = await queueCard();
    await drain();
    const err = row(queued.id).last_error as string;
    expect(err).not.toContain(APP_SECRET);
    expect(err.length).toBeLessThanOrEqual(300);
  });

  it("treats a throwing adapter as a retryable failure with a sanitised message", async () => {
    fake.state.sendResult = async () => {
      throw new Error(`socket hang up (key ${APP_SECRET})`);
    };
    const queued = await queueCard();
    await drain();
    expect(row(queued.id).status).toBe("retry");
    expect(row(queued.id).last_error).not.toContain(APP_SECRET);
  });

  it("two concurrent drains never double-send (claim lease)", async () => {
    const queued = await queueCard();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.state.sendResult = async () => {
      await gate;
      return { ok: true, externalMessageId: "om_x" };
    };

    const a = drain();
    const b = drain();
    await Promise.resolve();
    release();
    const [sa, sb] = await Promise.all([a, b]);

    expect(fake.calls.sends).toHaveLength(1);
    expect(sa.claimed + sb.claimed).toBe(1);
    expect(row(queued.id).status).toBe("sent");
  });

  it("skips a leased row, and takes it over once the lease expires (crashed drain)", async () => {
    const queued = await queueCard();
    row(queued.id).locked_until = new Date(Date.now() + LEASE_MS).toISOString();

    expect((await drain()).claimed).toBe(0);
    expect(fake.calls.sends).toHaveLength(0);

    vi.setSystemTime(new Date(Date.now() + LEASE_MS + 1000));
    expect((await drain()).sent).toBe(1);
  });

  it("leaves queued rows untouched while the connector is paused, and sends them after resume", async () => {
    db.rows("integration_connectors")[0].status = "paused";
    const queued = await queueCard();

    const s = await drain();
    expect(s).toMatchObject({ claimed: 1, deferred: 1, sent: 0 });
    expect(fake.calls.sends).toHaveLength(0);
    expect(row(queued.id)).toMatchObject({ status: "pending", attempts: 0, locked_until: null });

    db.rows("integration_connectors")[0].status = "active";
    expect((await drain()).sent).toBe(1);
  });

  it("supersedes rows of a revoked connector instead of sending them", async () => {
    db.rows("integration_connectors")[0].status = "revoked";
    const queued = await queueCard();
    expect((await drain()).superseded).toBe(1);
    expect(row(queued.id)).toMatchObject({ status: "superseded", last_error: "connector revoked" });
    expect(fake.calls.sends).toHaveLength(0);
  });

  it("retries (not dies) when the connector secrets cannot be decrypted", async () => {
    db.rows("integration_connectors")[0].secret_enc = "bm9wZQ==.bm9wZQ==.bm9wZQ==";
    const queued = await queueCard();
    await drain();
    expect(row(queued.id)).toMatchObject({ status: "retry" });
    expect(row(queued.id).last_error).toMatch(/unreadable/);
  });

  it("retries when no adapter can be loaded", async () => {
    clearAdapters(); // lark module is mocked to export nothing
    const queued = await queueCard();
    await drain();
    expect(row(queued.id)).toMatchObject({ status: "retry", last_error: "Platform adapter is unavailable" });
  });

  it("marks a malformed card delivery dead rather than retrying it forever", async () => {
    const queued = await queueCard({ payload: {} });
    await drain();
    expect(row(queued.id).status).toBe("dead");
  });

  it("is scoped to the workspace it is asked to drain", async () => {
    const queued = await queueCard();
    db.seed("integration_deliveries", [
      {
        id: "foreign",
        workspace_id: OTHER_WS,
        connector_id: "other",
        kind: "digest",
        status: "pending",
        attempts: 0,
        next_attempt_at: T0.toISOString(),
        external_target: "oc_x",
        payload: { data: {} },
      },
    ]);
    const s = await drain();
    expect(s.claimed).toBe(1);
    expect(row("foreign").status).toBe("pending");
    expect(row(queued.id).status).toBe("sent");
  });

  it("restricts a drain to the given ids", async () => {
    const a = await queueCard();
    const b = await queueCard({ recipient_profile_id: ids.manager2, external_target: "ou_mia" });
    const s = await drain({ ids: [b.id] });
    expect(s.claimed).toBe(1);
    expect(row(a.id).status).toBe("pending");
    expect(row(b.id).status).toBe("sent");
  });
});

describe("drainDeliveries — other kinds", () => {
  const decided: ApprovalDecidedEvent = {
    ...event,
    status: "approved",
    decidedByLabel: "Mia Manager",
    channel: "lark",
  };

  async function queueUpdate(parentId: string) {
    const [u] = await insertDeliveries(WS, CONNECTOR_ID, [
      {
        kind: "decision_update",
        approval_kind: "change_request",
        approval_id: ids.approval,
        recipient_profile_id: ids.manager,
        external_target: "ou_max",
        parent_delivery_id: parentId,
        payload: { event: decided },
      },
    ]);
    return u;
  }

  it("patches the card the parent delivery sent, using the parent's message id", async () => {
    const card = await queueCard();
    await drain();
    const update = await queueUpdate(card.id);

    await drain();

    expect(fake.calls.updates).toEqual([{ externalMessageId: "om_1", body: { card: "decided", status: "approved" } }]);
    expect(row(update.id)).toMatchObject({ status: "sent", external_message_id: "om_1" });
  });

  it("waits (retries) while the parent card is still in flight, and drops the update if the card never went out", async () => {
    const card = await queueCard();
    const update = await queueUpdate(card.id);
    // The queue is ordered by next_attempt_at, so the update runs in the same drain as an unsent card;
    // hold the card back by leasing it.
    row(card.id).locked_until = new Date(Date.now() + LEASE_MS).toISOString();

    await drain();
    expect(row(update.id)).toMatchObject({ status: "retry", last_error: "Card not delivered yet" });
    expect(fake.calls.updates).toHaveLength(0);

    row(card.id).status = "superseded";
    vi.setSystemTime(new Date(Date.now() + 2 * MIN));
    await drain({ ids: [update.id] });
    expect(row(update.id).status).toBe("superseded");
  });

  it("sends a digest to the group chat id", async () => {
    const data: DigestData = {
      workspaceName: "Acme PMO",
      generatedAt: T0.toISOString(),
      appUrl: "https://pm.example.test",
      projects: [{ id: "p1", name: "Apollo", health: "red", status: "active" }],
      milestonesDueSoon: [],
      openHighRisks: 2,
      pendingApprovals: 1,
    };
    const queued = await enqueueDigest(connectorRow(), "oc_team", data, "manual");
    expect(queued?.payload).toMatchObject({ trigger: "manual" });

    await drain();

    expect(fake.calls.sends).toEqual([
      { receiveIdType: "chat_id", receiveId: "oc_team", body: { card: "digest", projects: 1 }, idempotencyKey: queued?.id },
    ]);
  });

  it("sends a pre-rendered bot reply to the right target type", async () => {
    const hi = await enqueueBotReply(connectorRow(), { receiveIdType: "chat_id", receiveId: "oc_room", body: { text: "hi" } });
    const yo = await enqueueBotReply(connectorRow(), { receiveIdType: "open_id", receiveId: "ou_max", body: { text: "yo" } });
    await drain();
    expect(fake.calls.sends).toEqual([
      { receiveIdType: "chat_id", receiveId: "oc_room", body: { text: "hi" }, idempotencyKey: hi?.id },
      { receiveIdType: "open_id", receiveId: "ou_max", body: { text: "yo" }, idempotencyKey: yo?.id },
    ]);
  });
});

describe("drainDueRetries", () => {
  it("takes a bounded batch of due rows for ONE workspace and honours the lease", async () => {
    for (let i = 0; i < OPPORTUNISTIC_RETRY_BATCH + 3; i++) {
      await queueCard({ recipient_profile_id: null, approval_kind: null, approval_id: null, kind: "digest", external_target: "oc_" + i, payload: { data: {} } });
    }
    const first = await drainDueRetries(WS);
    expect(first.claimed).toBe(OPPORTUNISTIC_RETRY_BATCH);
    const second = await drainDueRetries(WS);
    expect(second.claimed).toBe(3);
    expect((await drainDueRetries(OTHER_WS)).claimed).toBe(0);
  });
});

describe("insertDeliveries", () => {
  it("refuses to queue a second pending card for the same recipient + approval (DB backstop)", async () => {
    await queueCard();
    await expect(queueCard()).rejects.toThrow(/Failed to queue deliveries/);
  });

  it("is a no-op for an empty batch", async () => {
    expect(await insertDeliveries(WS, CONNECTOR_ID, [])).toEqual([]);
    expect(db.rows("integration_deliveries")).toHaveLength(0);
  });
});

describe("one delivery = one card = one token", () => {
  it("passes the delivery id as the platform idempotency key (<= 50 chars)", async () => {
    const queued = await queueCard();
    await drain();
    expect(fake.calls.sends[0].idempotencyKey).toBe(queued.id);
    expect((fake.calls.sends[0].idempotencyKey as string).length).toBeLessThanOrEqual(50);
  });

  it("a retried delivery carries the SAME token and the same key, and mints no second token row", async () => {
    fake.state.sendResult = async () => ({ ok: false, retryable: true, error: "request timeout" });
    const queued = await queueCard();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect((await drain()).claimed).toBe(1);
      vi.setSystemTime(new Date(Date.now() + 13 * 60 * 60_000)); // past the longest backoff
    }

    expect(row(queued.id).status).toBe("dead");
    expect(fake.calls.cards).toHaveLength(MAX_ATTEMPTS);
    expect(new Set(fake.calls.cards.map((c) => c.ctx.actionToken)).size).toBe(1);
    expect([...new Set(fake.calls.sends.map((s) => s.idempotencyKey))]).toEqual([queued.id]);
    expect(db.rows("action_tokens")).toHaveLength(1); // not one per attempt
  });

  it("derives the token from the delivery id: stable per delivery, different between deliveries, hash-only at rest", async () => {
    const a = await queueCard();
    const b = await queueCard({ recipient_profile_id: ids.manager2, external_target: "ou_mia" });
    await drain();

    const tokenOf = (id: string) => fake.calls.cards[[a.id, b.id].indexOf(id)].ctx.actionToken;
    expect(tokenOf(a.id)).toBe(deriveActionToken(a.id, ACTION_TOKEN_PREFIX).raw);
    expect(tokenOf(b.id)).toBe(deriveActionToken(b.id, ACTION_TOKEN_PREFIX).raw);
    expect(tokenOf(a.id)).not.toBe(tokenOf(b.id));
    expect(JSON.stringify(db.tables)).not.toContain(tokenOf(a.id));
    expect(db.rows("action_tokens").map((t) => t.delivery_id).sort()).toEqual([a.id, b.id].sort());
  });

  it("a token minted by an earlier attempt that never reached the platform is reused, not duplicated", async () => {
    const queued = await queueCard();
    const { hash } = deriveActionToken(queued.id, ACTION_TOKEN_PREFIX);
    db.seed("action_tokens", [
      {
        id: "t-existing",
        workspace_id: WS,
        delivery_id: queued.id,
        recipient_profile_id: ids.manager,
        approval_kind: "change_request",
        approval_id: ids.approval,
        token_hash: hash,
        expires_at: new Date(Date.now() + ACTION_TOKEN_TTL_MS).toISOString(),
        used_at: null,
      },
    ]);
    await drain();
    expect(db.rows("action_tokens")).toHaveLength(1);
    expect(row(queued.id).status).toBe("sent");
  });
});

describe("pre-send request check", () => {
  const setStatus = (table: string, status: string) => {
    db.rows(table)[0].status = status;
  };

  it.each([
    ["task_deletion", "deletion_requests", "committed"],
    ["project_deletion", "deletion_requests", "rejected"],
    ["change_request", "change_requests", "approved"],
    ["timesheet", "timesheet_submissions", "approved"],
  ] as const)("a %s card is superseded, with no token and no send, once the request is decided", async (kind, table, status) => {
    const queued = await queueCard({ approval_kind: kind });
    setStatus(table, status);

    const s = await drain();

    expect(s).toMatchObject({ claimed: 1, superseded: 1, sent: 0 });
    expect(row(queued.id)).toMatchObject({ status: "superseded", last_error: "request already decided" });
    expect(fake.calls.sends).toHaveLength(0);
    expect(db.rows("action_tokens")).toHaveLength(0);
  });

  it("a change request still under review is still pending", async () => {
    await queueCard();
    setStatus("change_requests", "under_review");
    expect((await drain()).sent).toBe(1);
  });

  it("supersedes a card whose request no longer exists", async () => {
    const queued = await queueCard();
    db.tables.change_requests = [];
    await drain();
    expect(row(queued.id)).toMatchObject({ status: "superseded", last_error: "request no longer exists" });
    expect(fake.calls.sends).toHaveLength(0);
  });

  it("only trusts a request in the delivery's own workspace", async () => {
    const queued = await queueCard();
    db.rows("change_requests")[0].workspace_id = OTHER_WS;
    await drain();
    expect(row(queued.id).status).toBe("superseded");
    expect(fake.calls.sends).toHaveLength(0);
  });

  it("a failed state read is a retryable failure: it neither sends nor decides the request is gone", async () => {
    const queued = await queueCard();
    db.failNext({ table: "change_requests", op: "select", error: { message: "connection reset" } });
    await drain();
    expect(row(queued.id)).toMatchObject({ status: "retry", attempts: 1 });
    expect(fake.calls.sends).toHaveLength(0);
    expect(db.rows("action_tokens")).toHaveLength(0);
  });
});

describe("lease handling", () => {
  it("measures every lease from the clock at claim time, not from when the drain began", async () => {
    const a = await queueCard();
    const b = await queueCard({ recipient_profile_id: ids.manager2, external_target: "ou_mia" });
    const claimedAt: { id: string; lockedUntil: number; now: number }[] = [];
    const render = fake.adapter.renderApprovalCard;
    fake.adapter.renderApprovalCard = (ev, ctx) => {
      const leased = db.rows("integration_deliveries").find((r) => r.locked_until) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      claimedAt.push({ id: leased.id, lockedUntil: Date.parse(leased.locked_until), now: Date.now() });
      return render(ev, ctx);
    };
    fake.state.sendResult = async () => {
      vi.setSystemTime(new Date(Date.now() + 5 * MIN)); // a slow platform: the next claim is minutes later
      return { ok: true, externalMessageId: "om_slow" };
    };

    await drain({ ids: [a.id, b.id] });

    expect(claimedAt.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(claimedAt[1].now - claimedAt[0].now).toBe(5 * MIN);
    for (const c of claimedAt) expect(c.lockedUntil - c.now).toBe(LEASE_MS);
  });

  it("renews the lease right before the platform call", async () => {
    const queued = await queueCard();
    const render = fake.adapter.renderApprovalCard;
    fake.adapter.renderApprovalCard = (ev, ctx) => {
      vi.setSystemTime(new Date(Date.now() + MIN)); // time passes between claim and send
      return render(ev, ctx);
    };
    let leaseAtSend = 0;
    fake.state.sendResult = async () => {
      leaseAtSend = Date.parse(row(queued.id).locked_until);
      return { ok: true, externalMessageId: "om_1" };
    };

    await drain();

    expect(leaseAtSend - Date.now()).toBe(LEASE_MS);
    expect(row(queued.id)).toMatchObject({ status: "sent", locked_until: null });
  });

  it("does not send when the lease was lost to another drain, and leaves that drain's row alone", async () => {
    const queued = await queueCard();
    const foreign = "2099-01-01T00:00:00.000Z";
    const render = fake.adapter.renderApprovalCard;
    fake.adapter.renderApprovalCard = (ev, ctx) => {
      row(queued.id).locked_until = foreign; // someone else took the row over
      return render(ev, ctx);
    };

    const s = await drain();

    expect(s).toMatchObject({ claimed: 1, sent: 0, retried: 0, dead: 0, superseded: 0 });
    expect(fake.calls.sends).toHaveLength(0);
    expect(row(queued.id)).toMatchObject({ status: "pending", attempts: 0, locked_until: foreign });
  });
});

describe("drain size and time", () => {
  const queueReplies = (n: number) =>
    insertDeliveries(
      WS,
      CONNECTOR_ID,
      Array.from({ length: n }, (_, i) => ({
        kind: "bot_reply" as const,
        external_target: `ou_${i}`,
        payload: { receiveIdType: "open_id", body: { text: String(i) } },
      })),
    );

  it("an ids-scoped drain is never capped: more approvers than a page all get their card", async () => {
    const queued = await queueReplies(DEFAULT_DRAIN_LIMIT + 7);
    const s = await drain({ ids: queued.map((d) => d.id) });
    expect(s.claimed).toBe(DEFAULT_DRAIN_LIMIT + 7);
    expect(fake.calls.sends).toHaveLength(DEFAULT_DRAIN_LIMIT + 7);
  });

  it("pages a very large id list instead of putting it all in one query", async () => {
    const queued = await queueReplies(ID_BATCH * 2 + 5);
    const s = await drain({ ids: queued.map((d) => d.id) });
    expect(s.sent).toBe(ID_BATCH * 2 + 5);
    expect(db.rows("integration_deliveries").every((r) => r.status === "sent")).toBe(true);
  });

  it("an unscoped drain still takes one bounded page", async () => {
    await queueReplies(DEFAULT_DRAIN_LIMIT + 5);
    expect((await drain()).claimed).toBe(DEFAULT_DRAIN_LIMIT);
    expect((await drain()).claimed).toBe(5);
  });

  it("is a no-op for an empty id list", async () => {
    await queueCard();
    expect(await drain({ ids: [] })).toMatchObject({ claimed: 0, sent: 0 });
    expect(fake.calls.sends).toHaveLength(0);
  });

  it("stops starting rows once the deadline passes and says how many it left", async () => {
    await queueReplies(5);
    fake.state.sendResult = async () => {
      vi.setSystemTime(new Date(Date.now() + 10_000)); // each send takes 10 s
      return { ok: true, externalMessageId: "om_x" };
    };

    const s = await drain({ deadline: Date.now() + 25_000 }); // rows start at +0 s, +10 s, +20 s, then +30 s is too late

    expect(s).toMatchObject({ claimed: 3, sent: 3, deadlineSkipped: 2 });
    expect(db.rows("integration_deliveries").filter((r) => r.status === "pending")).toHaveLength(2);
  });

  it("never drains a held digest: it has no data yet and no audit row", async () => {
    const [held] = await insertDeliveries(WS, CONNECTOR_ID, [
      { kind: "digest", external_target: "oc_team", payload: { trigger: "scheduled", week_start: "2026-10-12", held: true } },
    ]);
    const s = await drain();
    expect(s.claimed).toBe(0);
    expect(fake.calls.sends).toHaveLength(0);
    expect(row(held.id)).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("a decision patch that ran before its card settled", () => {
  it("is retried at once when the card has landed by the time the patch re-checks", async () => {
    const card = await queueCard();
    row(card.id).locked_until = new Date(Date.now() + LEASE_MS).toISOString(); // the card is in flight
    const decided: ApprovalDecidedEvent = { ...event, status: "approved", decidedByLabel: "Mia Manager", channel: "ui" };
    const [update] = await insertDeliveries(WS, CONNECTOR_ID, [
      {
        kind: "decision_update",
        approval_kind: "change_request",
        approval_id: ids.approval,
        recipient_profile_id: ids.manager,
        external_target: "ou_max",
        parent_delivery_id: card.id,
        payload: { event: decided },
      },
    ]);

    // The card's send settles between the patch's first look at its parent and its re-check.
    const realFrom = db.from.bind(db);
    let parentReads = 0;
    db.from = (table: string) => {
      const q = realFrom(table);
      if (table !== "integration_deliveries") return q;
      const maybeSingle = q.maybeSingle.bind(q);
      q.maybeSingle = () => {
        parentReads += 1;
        if (parentReads === 2) Object.assign(row(card.id), { status: "sent", external_message_id: "om_landed", locked_until: null });
        return maybeSingle();
      };
      return q;
    };

    await drain({ ids: [update.id] });

    expect(parentReads).toBe(3); // first look, re-check, then the retried patch's own read
    expect(fake.calls.updates).toEqual([{ externalMessageId: "om_landed", body: { card: "decided", status: "approved" } }]);
    expect(row(update.id)).toMatchObject({ status: "sent", attempts: 2 });
  });
});

describe("queue guarantees", () => {
  it("raises a typed DuplicateDeliveryError when a unique index refuses the row", async () => {
    await queueCard();
    await expect(queueCard()).rejects.toBeInstanceOf(DuplicateDeliveryError);
  });

  it("holds one live scheduled digest per connector per ISO week, and nothing else", async () => {
    const digest = (over: Record<string, unknown> = {}) =>
      insertDeliveries(WS, CONNECTOR_ID, [
        { kind: "digest", external_target: "oc_team", payload: { trigger: "scheduled", week_start: "2026-10-12", ...over } },
      ]);
    const [first] = await digest();
    await expect(digest()).rejects.toBeInstanceOf(DuplicateDeliveryError);
    await digest({ week_start: "2026-10-19" }); // another week
    await insertDeliveries(WS, CONNECTOR_ID, [
      { kind: "digest", external_target: "oc_team", payload: { trigger: "manual", week_start: "2026-10-12" } },
    ]); // a manual send never uses the slot
    row(first.id).status = "superseded";
    await digest(); // a retired row frees the slot
    expect(db.rows("integration_deliveries")).toHaveLength(4);
  });
});

describe("content-version binding (approve what you saw)", () => {
  const V1 = "2026-10-16T08:00:00.000Z"; // what the seeded request starts at
  const V2 = "2026-10-16T09:30:00.000Z";
  const versioned = (version?: string | null) => ({ payload: { event: { ...event, ...(version !== undefined ? { version } : {}) } } });
  const tokenRow = () => db.rows("action_tokens")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("binds the token to the version the card's event carries", async () => {
    await queueCard(versioned(V1));
    await drain();
    expect(tokenRow().approval_version).toBe(V1);
    expect(tokenRow().superseded_reason ?? null).toBeNull();
  });

  it("binds a token to the version current at mint time when the event does not know its version", async () => {
    await queueCard(versioned());
    await drain();
    expect(tokenRow().approval_version).toBe(V1);
  });

  it("binds a timesheet token to the submission's version too", async () => {
    await queueCard({ ...versioned(), approval_kind: "timesheet" });
    db.rows("timesheet_submissions")[0].updated_at = V2;
    await drain();
    expect(tokenRow().approval_version).toBe(V2);
  });

  it("binds nothing for a deletion request, which has no editable content", async () => {
    await queueCard({ ...versioned(), approval_kind: "task_deletion" });
    await drain();
    expect(tokenRow().approval_version).toBeNull();
  });

  it("never sends a card whose content predates an edit: superseded, no token (the replacement carries the new content)", async () => {
    const queued = await queueCard(versioned(V1));
    db.rows("change_requests")[0].updated_at = V2; // edited after the event was captured

    const s = await drain();

    expect(s).toMatchObject({ superseded: 1, sent: 0 });
    expect(row(queued.id)).toMatchObject({ status: "superseded", last_error: "request changed before delivery" });
    expect(db.rows("action_tokens")).toHaveLength(0);
    expect(fake.calls.sends).toHaveLength(0);
  });

  it("does not mistake a microsecond-precision copy of the same instant for an edit", async () => {
    await queueCard(versioned(V1));
    db.rows("change_requests")[0].updated_at = "2026-10-16T08:00:00.000123+00:00";
    expect((await drain()).sent).toBe(1);
  });

  it("a retry keeps the version the token was first bound to", async () => {
    fake.state.sendResult = async () => ({ ok: false, retryable: true, error: "503" });
    const queued = await queueCard(versioned());
    await drain();
    expect(tokenRow().approval_version).toBe(V1);

    db.rows("change_requests")[0].updated_at = V2; // an edit between attempts
    vi.setSystemTime(new Date(Date.now() + 2 * MIN));
    fake.state.sendResult = async () => ({ ok: true, externalMessageId: "om_retry" });
    await drain({ ids: [queued.id] });

    expect(db.rows("action_tokens")).toHaveLength(1);
    expect(tokenRow().approval_version).toBe(V1); // so a tap on this card is refused as stale
  });

  it("patches a card with the 'updated, see the new card' body when the patch is the changed variant", async () => {
    const card = await queueCard(versioned(V1));
    await drain();
    const [update] = await insertDeliveries(WS, CONNECTOR_ID, [
      {
        kind: "decision_update",
        approval_kind: "change_request",
        approval_id: ids.approval,
        recipient_profile_id: ids.manager,
        external_target: "ou_max",
        parent_delivery_id: card.id,
        payload: { event: { ...event, version: V2 }, variant: "changed" },
      },
    ]);

    await drain({ ids: [update.id] });

    expect(fake.calls.updates).toEqual([{ externalMessageId: "om_1", body: { card: "changed", title: event.title } }]);
    expect(row(update.id).status).toBe("sent");
  });

  it("an EDIT during an in-flight send: the stray token is retired as 'changed', the waiting patch runs at once, and the replacement is issued", async () => {
    const card = await queueCard(versioned(V1));
    const followUps: ApprovalEvent[] = [];
    setChangedFollowUp(async (ev) => {
      followUps.push(ev);
    });
    fake.state.sendResult = async () => {
      // the requester edits while the send is out, and the edit's fan-out queues a patch that can only wait
      db.rows("change_requests")[0].updated_at = V2;
      await insertDeliveries(WS, CONNECTOR_ID, [
        {
          kind: "decision_update",
          approval_kind: "change_request",
          approval_id: ids.approval,
          recipient_profile_id: ids.manager,
          external_target: "ou_max",
          parent_delivery_id: card.id,
          payload: { event: { ...event, version: V2 }, variant: "changed" },
        },
      ]);
      return { ok: true, externalMessageId: "om_flight" };
    };

    try {
      await drain({ ids: [card.id] });
    } finally {
      setChangedFollowUp(null);
    }

    expect(row(card.id)).toMatchObject({ status: "sent", external_message_id: "om_flight" });
    expect(tokenRow()).toMatchObject({ approval_version: V1, superseded_reason: "changed" });
    expect(tokenRow().used_at).not.toBeNull();
    expect(fake.calls.updates).toEqual([{ externalMessageId: "om_flight", body: { card: "changed", title: event.title } }]);
    expect(followUps).toHaveLength(1);
    expect(followUps[0].version).toBe(V2);
  });

  it("a request still at the token's version is left alone after the send", async () => {
    await queueCard(versioned(V1));
    await drain();
    expect(tokenRow().used_at).toBeNull();
  });
});

describe("sameVersion", () => {
  it("treats two absent versions as the same, one absent as different, and compares instants", () => {
    expect(sameVersion(null, undefined)).toBe(true);
    expect(sameVersion("2026-10-16T08:00:00.000Z", null)).toBe(false);
    expect(sameVersion(undefined, "2026-10-16T08:00:00.000Z")).toBe(false);
    expect(sameVersion("2026-10-16T08:00:00.000Z", "2026-10-16T08:00:00.000Z")).toBe(true);
    expect(sameVersion("2026-10-16T08:00:00.000Z", "2026-10-16T08:00:00.000999+00:00")).toBe(true);
    expect(sameVersion("2026-10-16T08:00:00.000Z", "2026-10-16T08:00:00.001Z")).toBe(false);
    expect(sameVersion("not a date", "also not")).toBe(false);
  });

  it("knows which kinds have a content version", () => {
    expect(isVersionedKind("change_request")).toBe(true);
    expect(isVersionedKind("timesheet")).toBe(true);
    expect(isVersionedKind("task_deletion")).toBe(false);
    expect(isVersionedKind("project_deletion")).toBe(false);
  });
});
