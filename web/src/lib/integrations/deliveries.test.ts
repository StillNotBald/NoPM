import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
// The real adapter is W3b's; the hub core must work with ANY registered adapter.
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));

import {
  ACTION_TOKEN_TTL_MS,
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
  planAfterFailure,
  registerAdapter,
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

    expect(fake.calls.sends).toEqual([{ receiveIdType: "chat_id", receiveId: "oc_team", body: { card: "digest", projects: 1 } }]);
  });

  it("sends a pre-rendered bot reply to the right target type", async () => {
    await enqueueBotReply(connectorRow(), { receiveIdType: "chat_id", receiveId: "oc_room", body: { text: "hi" } });
    await enqueueBotReply(connectorRow(), { receiveIdType: "open_id", receiveId: "ou_max", body: { text: "yo" } });
    await drain();
    expect(fake.calls.sends).toEqual([
      { receiveIdType: "chat_id", receiveId: "oc_room", body: { text: "hi" } },
      { receiveIdType: "open_id", receiveId: "ou_max", body: { text: "yo" } },
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
