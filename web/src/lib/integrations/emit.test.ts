import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { afterMock } = vi.hoisted(() => ({ afterMock: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: afterMock,
}));

import { clearAdapters, registerAdapter, drainDeliveries } from "./deliveries";
import {
  CARD_BUDGET_PER_HOUR,
  emitApprovalChanged,
  emitApprovalDecided,
  emitApprovalRequested,
  runApprovalChanged,
  runApprovalDecided,
  runApprovalRequested,
} from "./emit";
import {
  CONNECTOR_ID,
  FakeDb,
  OTHER_WS,
  REQUEST_VERSION,
  TEST_ENCRYPTION_KEY,
  WS,
  createFakeAdapter,
  ids,
  linkIdentity,
  seedPendingRequests,
  seedWorkspace,
} from "./test-support";
import type { ApprovalDecidedEvent, ApprovalEvent } from "./types";

let db: FakeDb;
let fake: ReturnType<typeof createFakeAdapter>;

const event: ApprovalEvent = {
  workspaceId: WS,
  kind: "task_deletion",
  id: ids.approval,
  title: 'Delete task "Migrate billing DB"',
  summary: "Obsolete",
  projectId: null,
  projectName: "Apollo",
  requestedByLabel: "Rae Requester",
  requesterPrincipalId: ids.requester,
};

const decided: ApprovalDecidedEvent = {
  ...event,
  status: "committed",
  decidedByLabel: "Max Manager",
  channel: "ui",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T09:00:00.000Z"));
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  afterMock.mockReset();
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

const deliveries = (kind?: string) =>
  db.rows("integration_deliveries").filter((r) => (kind ? r.kind === kind : true)) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const recipients = () => deliveries("approval_card").map((d) => d.recipient_profile_id).sort();

describe("emitApprovalRequested — fan-out", () => {
  it("sends a card to each linked admin/manager and NEVER to the requester's human principal", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    linkIdentity(db, ids.manager2, "ou_mia");
    linkIdentity(db, ids.requester, "ou_rae"); // linked manager, but the person who raised it
    linkIdentity(db, ids.member, "ou_mo"); // linked, but not an approver role
    linkIdentity(db, ids.viewer, "ou_vi");

    await runApprovalRequested(event);

    expect(recipients()).toEqual([ids.manager, ids.manager2].sort());
    expect(fake.calls.sends.map((s) => s.receiveId).sort()).toEqual(["ou_max", "ou_mia"]);
    expect(fake.calls.sends.every((s) => s.receiveIdType === "open_id")).toBe(true);
    // every card sent: one single-use token each, bound to its own recipient
    const tokens = db.rows("action_tokens");
    expect(tokens.map((t) => t.recipient_profile_id).sort()).toEqual([ids.manager, ids.manager2].sort());
    expect(new Set(tokens.map((t) => t.token_hash)).size).toBe(2);
    expect(tokens.every((t) => t.approval_kind === "task_deletion" && t.approval_id === ids.approval)).toBe(true);
  });

  it("excludes the requester even when the request came from their agent token (principal, not actor id)", async () => {
    linkIdentity(db, ids.requester, "ou_rae");
    linkIdentity(db, ids.manager, "ou_max");
    await runApprovalRequested({ ...event, requestedByLabel: "ci-agent (token)" });
    expect(recipients()).toEqual([ids.manager]);
  });

  it("skips approvers with no active link (they still see the request in the console)", async () => {
    linkIdentity(db, ids.manager, "ou_max"); // admin and manager2 unlinked
    await runApprovalRequested(event);
    expect(recipients()).toEqual([ids.manager]);
  });

  it("skips a revoked link", async () => {
    const link = linkIdentity(db, ids.manager, "ou_max");
    link.revoked_at = "2026-10-10T00:00:00.000Z";
    db.rows("external_identities")[0].revoked_at = "2026-10-10T00:00:00.000Z";
    await runApprovalRequested(event);
    expect(deliveries()).toHaveLength(0);
  });

  it("with an unknown requester principal (legacy token) nobody is excluded — and nothing crashes", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    linkIdentity(db, ids.requester, "ou_rae");
    await runApprovalRequested({ ...event, requesterPrincipalId: null });
    expect(recipients()).toEqual([ids.manager, ids.requester].sort());
  });

  it("does nothing when approvals are disabled, the connector is paused/revoked, or none exists", async () => {
    linkIdentity(db, ids.manager, "ou_max");

    db.rows("integration_connectors")[0].config = { ...(db.rows("integration_connectors")[0].config as object), approvals: { enabled: false } };
    await runApprovalRequested(event);
    expect(deliveries()).toHaveLength(0);

    db.rows("integration_connectors")[0].config = { ...(db.rows("integration_connectors")[0].config as object), approvals: { enabled: true } };
    db.rows("integration_connectors")[0].status = "paused";
    await runApprovalRequested(event);
    expect(deliveries()).toHaveLength(0);

    db.rows("integration_connectors")[0].status = "revoked";
    await runApprovalRequested(event);
    expect(deliveries()).toHaveLength(0);

    await runApprovalRequested({ ...event, workspaceId: OTHER_WS });
    expect(deliveries()).toHaveLength(0);
    expect(fake.calls.sends).toHaveLength(0);
  });

  it("does not queue a second card for a recipient whose card is still open", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    await runApprovalRequested(event);
    await runApprovalRequested(event); // duplicate emit
    expect(deliveries("approval_card")).toHaveLength(1);
    expect(fake.calls.sends).toHaveLength(1);
  });

  it("does not queue a duplicate while the first card is still waiting to be sent", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    db.rows("integration_connectors")[0].status = "active";
    fake.state.sendResult = async () => ({ ok: false, retryable: true, error: "429" });
    await runApprovalRequested(event); // fails -> retry
    await runApprovalRequested(event);
    expect(deliveries("approval_card")).toHaveLength(1);
  });

  it("re-raising a decided request (e.g. a reopened timesheet) sends a fresh card", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    await runApprovalRequested(event);
    await runApprovalDecided(decided);
    await runApprovalRequested(event);
    expect(deliveries("approval_card")).toHaveLength(2);
    expect(fake.calls.sends.length).toBeGreaterThanOrEqual(2);
  });

  it("only touches the emitting workspace's connector and identities", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    db.seed("integration_connectors", [
      { id: "other-connector", workspace_id: OTHER_WS, kind: "lark", name: "Other", status: "active", config: { approvals: { enabled: true } }, secret_enc: "x" },
    ]);
    await runApprovalRequested(event);
    expect(deliveries().every((d) => d.workspace_id === WS && d.connector_id === CONNECTOR_ID)).toBe(true);
  });
});

describe("emitApprovalDecided — closing the loop", () => {
  async function cardsSentTo(...profiles: [string, string][]) {
    for (const [id, open] of profiles) linkIdentity(db, id, open);
    await runApprovalRequested(event);
  }

  it("kills every open action token for the request and leaves other requests' tokens alone", async () => {
    await cardsSentTo([ids.manager, "ou_max"], [ids.manager2, "ou_mia"]);
    db.seed("action_tokens", [
      {
        id: "other-req",
        workspace_id: WS,
        delivery_id: "d",
        recipient_profile_id: ids.manager,
        approval_kind: "task_deletion",
        approval_id: "b0000000-0000-4000-8000-0000000000ff",
        token_hash: "h-other",
        expires_at: "2026-12-01T00:00:00.000Z",
        used_at: null,
      },
    ]);

    await runApprovalDecided(decided);

    const mine = db.rows("action_tokens").filter((t) => t.approval_id === ids.approval);
    expect(mine).toHaveLength(2);
    expect(mine.every((t) => t.used_at !== null)).toBe(true);
    expect(db.rows("action_tokens").find((t) => t.id === "other-req")?.used_at).toBeNull();
  });

  it("patches each sent card in place exactly once, whichever channel decided", async () => {
    await cardsSentTo([ids.manager, "ou_max"], [ids.manager2, "ou_mia"]);

    await runApprovalDecided({ ...decided, channel: "cli" });

    expect(fake.calls.updates.map((u) => u.externalMessageId).sort()).toEqual(["om_1", "om_2"]);
    expect(deliveries("decision_update")).toHaveLength(2);
    expect(deliveries("decision_update").every((d) => d.status === "sent")).toBe(true);

    await runApprovalDecided({ ...decided, channel: "cli" }); // duplicate emit
    expect(fake.calls.updates).toHaveLength(2);
    expect(deliveries("decision_update")).toHaveLength(2);
  });

  it("supersedes cards that were never sent so a decided request is never announced", async () => {
    fake.state.sendResult = async () => ({ ok: false, retryable: true, error: "503" });
    await cardsSentTo([ids.manager, "ou_max"]);
    expect(deliveries("approval_card")[0].status).toBe("retry");

    await runApprovalDecided(decided);

    expect(deliveries("approval_card")[0].status).toBe("superseded");
    expect(deliveries("decision_update")).toHaveLength(0);
    // a later drain must not send the superseded card
    vi.setSystemTime(new Date(Date.now() + 10 * 60_000));
    fake.calls.sends.length = 0;
    await drainDeliveries({ workspaceId: WS });
    expect(fake.calls.sends).toHaveLength(0);
  });

  it("handles a card still in flight: the update waits for the message id, then patches it", async () => {
    await cardsSentTo([ids.manager, "ou_max"]);
    const card = deliveries("approval_card")[0];
    // simulate an in-flight send: back to pending, leased, no message id yet
    Object.assign(db.rows("integration_deliveries").find((r) => r.id === card.id)!, {
      status: "pending",
      external_message_id: null,
      locked_until: new Date(Date.now() + 120_000).toISOString(),
    });

    await runApprovalDecided(decided);

    expect(deliveries("approval_card")[0].status).toBe("pending"); // not clobbered
    expect(deliveries("decision_update")).toHaveLength(1);
    expect(deliveries("decision_update")[0].status).toBe("retry"); // waiting on the card
    expect(fake.calls.updates).toHaveLength(0);

    // the card lands, the update goes through on the next drain
    Object.assign(db.rows("integration_deliveries").find((r) => r.id === card.id)!, {
      status: "sent",
      external_message_id: "om_late",
      locked_until: null,
    });
    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    await drainDeliveries({ workspaceId: WS });
    expect(fake.calls.updates).toEqual([{ externalMessageId: "om_late", body: { card: "decided", status: "committed" } }]);
  });

  it("kills tokens even when the connector is paused or gone (security does not depend on the kill switch)", async () => {
    await cardsSentTo([ids.manager, "ou_max"]);
    db.rows("integration_connectors")[0].status = "paused";
    await runApprovalDecided(decided);
    expect(db.rows("action_tokens").every((t) => t.used_at !== null)).toBe(true);
    // the patch is queued but not sent while paused
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("is a harmless no-op for a request that never produced a card", async () => {
    await runApprovalDecided(decided);
    expect(deliveries()).toHaveLength(0);
  });
});

describe("emit entry points — contract", () => {
  it("are synchronous, return nothing, and schedule the work through after()", () => {
    linkIdentity(db, ids.manager, "ou_max");
    const r1 = emitApprovalRequested(event);
    const r2 = emitApprovalDecided(decided);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(afterMock).toHaveBeenCalledTimes(2);
    expect(typeof afterMock.mock.calls[0][0]).toBe("function");
    // nothing has happened yet: I/O is deferred
    expect(deliveries()).toHaveLength(0);
  });

  it("the scheduled task performs the fan-out", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    let task: (() => Promise<void>) | undefined;
    afterMock.mockImplementation((fn: () => Promise<void>) => {
      task = fn;
    });
    emitApprovalRequested(event);
    await task!();
    expect(recipients()).toEqual([ids.manager]);
  });

  it("falls back to a detached promise outside a request scope (after() throws) and still never throws", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    afterMock.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    expect(() => emitApprovalRequested(event)).not.toThrow();
    await vi.waitFor(() => expect(recipients()).toEqual([ids.manager]));
  });

  it("swallows (and logs) a failing fan-out instead of throwing into the governed mutation", async () => {
    let task: (() => Promise<void>) | undefined;
    afterMock.mockImplementation((fn: () => Promise<void>) => {
      task = fn;
    });
    db.failNext({ table: "integration_connectors", op: "select", error: { message: "db unavailable" } });
    expect(() => emitApprovalRequested(event)).not.toThrow();
    await expect(task!()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("opportunistic retry pass", () => {
  /** Run whatever each emit scheduled through after(), the way a request would. */
  function collectTasks() {
    const tasks: Promise<void>[] = [];
    afterMock.mockImplementation((fn: () => Promise<void>) => {
      tasks.push(fn());
    });
    return () => Promise.all(tasks);
  }

  async function dueRetry(target: string, minutesAgo = 5) {
    const { insertDeliveries } = await import("./deliveries");
    const [row] = await insertDeliveries(WS, CONNECTOR_ID, [
      { kind: "bot_reply", external_target: target, payload: { receiveIdType: "open_id", body: { text: target } } },
    ]);
    const stored = db.rows("integration_deliveries").find((r) => r.id === row.id)!;
    stored.status = "retry";
    stored.attempts = 1;
    stored.next_attempt_at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    return row.id;
  }

  it("an event-triggered run also retries deliveries that are due, so retries advance whenever there is traffic", async () => {
    const id = await dueRetry("ou_stuck");
    const settle = collectTasks();

    emitApprovalRequested(event); // nobody linked: the event itself sends nothing
    await settle();

    expect(fake.calls.sends.map((s) => s.receiveId)).toEqual(["ou_stuck"]);
    expect(db.rows("integration_deliveries").find((r) => r.id === id)).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("leaves retries that are not due yet, dead rows and other workspaces' rows alone", async () => {
    const notDue = await dueRetry("ou_later", -30); // due in 30 minutes
    const dead = await dueRetry("ou_dead");
    db.rows("integration_deliveries").find((r) => r.id === dead)!.status = "dead";
    db.seed("integration_deliveries", [
      { id: "foreign", workspace_id: OTHER_WS, connector_id: "other", kind: "bot_reply", status: "retry", attempts: 1, next_attempt_at: new Date(Date.now() - 60_000).toISOString(), external_target: "ou_foreign", payload: { receiveIdType: "open_id", body: {} }, locked_until: null },
    ]);
    const settle = collectTasks();

    emitApprovalDecided(decided);
    await settle();

    expect(fake.calls.sends).toHaveLength(0);
    expect(db.rows("integration_deliveries").find((r) => r.id === notDue)!.status).toBe("retry");
    expect(db.rows("integration_deliveries").find((r) => r.id === "foreign")!.status).toBe("retry");
  });

  it("is bounded: at most one batch of due retries per event", async () => {
    for (let i = 0; i < 15; i++) await dueRetry("ou_" + i, 10 + i);
    const settle = collectTasks();

    emitApprovalRequested(event);
    await settle();

    expect(fake.calls.sends).toHaveLength(10);
    expect(db.rows("integration_deliveries").filter((r) => r.status === "retry")).toHaveLength(5);
  });

  it("uses the claim lease: a row another drain holds is not sent twice", async () => {
    const id = await dueRetry("ou_held");
    db.rows("integration_deliveries").find((r) => r.id === id)!.locked_until = new Date(Date.now() + 60_000).toISOString();
    const settle = collectTasks();

    emitApprovalRequested(event);
    await settle();

    expect(fake.calls.sends).toHaveLength(0);
  });

  it("runs AFTER the event's own work, and a failing retry pass never breaks the event or throws", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    await dueRetry("ou_stuck");
    fake.state.sendResult = async () => ({ ok: true, externalMessageId: "om_1" });
    const settle = collectTasks();

    emitApprovalRequested(event);
    await settle();

    // the new card went out first, then the retry
    expect(fake.calls.sends.map((s) => s.receiveId)).toEqual(["ou_max", "ou_stuck"]);

    db.failNext({ table: "integration_deliveries", op: "select", error: { message: "db blip" }, times: 99 });
    const settle2 = collectTasks();
    expect(() => emitApprovalDecided(decided)).not.toThrow();
    await expect(settle2()).resolves.toBeDefined();
  });
});

describe("reopened requests (e.g. a reopened timesheet)", () => {
  const reopened: ApprovalDecidedEvent = {
    ...event,
    kind: "timesheet",
    status: "reopened",
    decidedByLabel: "Max Manager",
    channel: "ui",
  };
  const submitted: ApprovalEvent = { ...event, kind: "timesheet" };

  it("closes the old cards AND sends a fresh card to the approvers (the governed code emits only Decided for a reopen)", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    linkIdentity(db, ids.manager2, "ou_mia");
    linkIdentity(db, ids.requester, "ou_rae");
    await runApprovalRequested(submitted);
    expect(deliveries("approval_card")).toHaveLength(2);
    const firstTokens = db.rows("action_tokens").map((t) => t.token_hash);
    fake.calls.sends.length = 0;

    const tasks: Promise<void>[] = [];
    afterMock.mockImplementation((fn: () => Promise<void>) => {
      tasks.push(fn());
    });
    emitApprovalDecided(reopened);
    await Promise.all(tasks);

    // old cards patched to the reopened state, all old tokens dead
    expect(fake.calls.updates).toHaveLength(2);
    expect(db.rows("action_tokens").filter((t) => firstTokens.includes(t.token_hash)).every((t) => t.used_at !== null)).toBe(true);
    // two NEW cards, to the same eligible approvers (never the submitter), each with a live token
    const cards = deliveries("approval_card");
    expect(cards).toHaveLength(4);
    expect(fake.calls.sends.map((s) => s.receiveId).sort()).toEqual(["ou_max", "ou_mia"]);
    const live = db.rows("action_tokens").filter((t) => t.used_at === null);
    expect(live).toHaveLength(2);
    expect(live.map((t) => t.recipient_profile_id).sort()).toEqual([ids.manager, ids.manager2].sort());
  });

  it("an ordinary decision (approved / rejected / committed / withdrawn) never re-requests", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    await runApprovalRequested(event);
    fake.calls.sends.length = 0;
    for (const status of ["approved", "rejected", "committed", "withdrawn"]) {
      const tasks: Promise<void>[] = [];
      afterMock.mockImplementation((fn: () => Promise<void>) => {
        tasks.push(fn());
      });
      emitApprovalDecided({ ...decided, status });
      await Promise.all(tasks);
    }
    expect(fake.calls.sends).toHaveLength(0);
    expect(deliveries("approval_card")).toHaveLength(1);
  });
});

describe("a request that is decided around the time its card goes out", () => {
  const requestRow = () => db.rows("deletion_requests")[0];

  it("decided before the card was sent: no card, no token, nothing live (the Decided-before-Requested order)", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    requestRow().status = "committed"; // the decision landed first
    await runApprovalDecided(decided); // ...and its fan-out found nothing to close

    await runApprovalRequested(event);

    expect(deliveries("approval_card")).toHaveLength(1);
    expect(deliveries("approval_card")[0]).toMatchObject({ status: "superseded", last_error: "request already decided" });
    expect(fake.calls.sends).toHaveLength(0);
    expect(db.rows("action_tokens")).toHaveLength(0);
  });

  it("decided WHILE the card is in flight: the stray token dies and the patch runs at once, not on the next drain", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    fake.state.sendResult = async () => {
      requestRow().status = "committed";
      await runApprovalDecided(decided); // the decision's fan-out runs while the send is still out
      return { ok: true, externalMessageId: "om_inflight" };
    };

    await runApprovalRequested(event);

    expect(deliveries("approval_card")[0]).toMatchObject({ status: "sent", external_message_id: "om_inflight" });
    // the card is already showing its decided state, with no wait for a later drain
    expect(fake.calls.updates).toEqual([{ externalMessageId: "om_inflight", body: { card: "decided", status: "committed" } }]);
    expect(deliveries("decision_update")).toHaveLength(1);
    expect(deliveries("decision_update")[0].status).toBe("sent");
    // and no token is left to act on
    expect(db.rows("action_tokens").every((t) => t.used_at !== null)).toBe(true);
  });

  it("a token minted after the decision's kill pass is killed once the send settles", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    // the decision commits after the card's own check but its token-kill ran before the token existed
    fake.state.sendResult = async () => {
      requestRow().status = "committed";
      return { ok: true, externalMessageId: "om_x" };
    };

    await runApprovalRequested(event);

    expect(db.rows("action_tokens")).toHaveLength(1);
    expect(db.rows("action_tokens")[0].used_at).not.toBeNull();
  });

  it("a request that is still pending after the send leaves its live token alone", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    await runApprovalRequested(event);
    expect(db.rows("action_tokens")).toHaveLength(1);
    expect(db.rows("action_tokens")[0].used_at).toBeNull();
    expect(fake.calls.updates).toHaveLength(0);
  });
});

describe("fan-out size and raced inserts", () => {
  it("sends every card to a request with more approvers than one drain page", async () => {
    const extra = Array.from({ length: 40 }, (_, i) => `a1000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    db.seed(
      "profiles",
      extra.map((id, i) => ({ id, workspace_id: WS, role: "manager", display_name: `Approver ${i}`, email: `a${i}@example.test` })),
    );
    extra.forEach((id, i) => linkIdentity(db, id, `ou_bulk_${i}`));

    await runApprovalRequested(event);

    expect(deliveries("approval_card")).toHaveLength(40);
    expect(deliveries("approval_card").every((d) => d.status === "sent")).toBe(true);
    expect(fake.calls.sends).toHaveLength(40);
    expect(new Set(fake.calls.sends.map((s) => s.idempotencyKey)).size).toBe(40);
  });

  it("a raced duplicate insert costs only the duplicate, not every other approver's card", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    linkIdentity(db, ids.manager2, "ou_mia");
    db.failNext({
      table: "integration_deliveries",
      op: "insert",
      error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_queued_approval_card"' },
    });

    await runApprovalRequested(event);

    expect(recipients()).toEqual([ids.manager, ids.manager2].sort());
    expect(fake.calls.sends.map((s) => s.receiveId).sort()).toEqual(["ou_max", "ou_mia"]);
  });
});

describe("emitApprovalChanged — a pending request is edited after its cards went out", () => {
  const V1 = REQUEST_VERSION;
  const V2 = "2026-10-16T10:15:00.000Z";
  const crEvent: ApprovalEvent = { ...event, kind: "change_request", title: "Change request CR-7: rename a label", version: V1 };
  const edited: ApprovalEvent = { ...crEvent, title: "Change request CR-7: delete production", version: V2 };
  const crRow = () => db.rows("change_requests")[0];
  const tokens = () => db.rows("action_tokens") as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any

  async function raised() {
    linkIdentity(db, ids.manager, "ou_max");
    linkIdentity(db, ids.manager2, "ou_mia");
    await runApprovalRequested(crEvent);
  }
  const edit = () => {
    crRow().updated_at = V2;
  };

  it("exports the entry point and schedules it like the other emitters", () => {
    expect(emitApprovalChanged(edited)).toBeUndefined();
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("retires every old token, patches the old cards to 'updated', and sends fresh cards bound to the new version", async () => {
    await raised();
    expect(tokens().map((t) => t.approval_version)).toEqual([V1, V1]);
    const oldCards = deliveries("approval_card").map((d) => d.id);

    edit();
    await runApprovalChanged(edited);

    // old tokens: spent, marked as retired-by-edit (a late tap says "changed", not "already decided")
    const old = tokens().filter((t) => t.approval_version === V1);
    expect(old).toHaveLength(2);
    expect(old.every((t) => t.used_at !== null && t.superseded_reason === "changed")).toBe(true);
    // old cards: patched once each, with the 'changed' body
    expect(fake.calls.updates.map((u) => u.externalMessageId).sort()).toEqual(["om_1", "om_2"]);
    expect(fake.calls.updates.every((u) => (u.body as { card: string }).card === "changed")).toBe(true);
    expect(deliveries("decision_update").filter((d) => d.payload.variant === "changed")).toHaveLength(2);
    expect(deliveries("decision_update").every((d) => d.status === "sent")).toBe(true);
    // fresh cards: one per approver, current content, tokens bound to V2 and live
    const fresh = deliveries("approval_card").filter((d) => !oldCards.includes(d.id));
    expect(fresh.map((d) => d.recipient_profile_id).sort()).toEqual([ids.manager, ids.manager2].sort());
    expect(fresh.every((d) => d.status === "sent" && d.payload.event.title === edited.title)).toBe(true);
    const live = tokens().filter((t) => t.used_at === null);
    expect(live).toHaveLength(2);
    expect(live.every((t) => t.approval_version === V2)).toBe(true);
    expect(fake.calls.sends).toHaveLength(4);
    expect(fake.calls.cards.slice(2).every((c) => c.ev.title === edited.title)).toBe(true);
  });

  it("reads the request's current version itself when the event does not carry one", async () => {
    await raised();
    edit();
    await runApprovalChanged({ ...edited, version: undefined });
    expect(tokens().filter((t) => t.used_at === null).every((t) => t.approval_version === V2)).toBe(true);
  });

  it("is idempotent: repeating the same change event issues nothing twice", async () => {
    await raised();
    edit();
    await runApprovalChanged(edited);
    const sends = fake.calls.sends.length;
    const cards = deliveries("approval_card").length;
    await runApprovalChanged(edited);
    expect(fake.calls.sends).toHaveLength(sends);
    expect(deliveries("approval_card")).toHaveLength(cards);
    expect(tokens().filter((t) => t.used_at === null)).toHaveLength(2);
  });

  it("supersedes a card still waiting to be sent instead of patching it, then sends the new one", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    fake.state.sendResult = async () => ({ ok: false, retryable: true, error: "503" });
    await runApprovalRequested(crEvent);
    const waiting = deliveries("approval_card")[0];
    expect(waiting.status).toBe("retry");

    edit();
    fake.state.sendResult = async () => ({ ok: true, externalMessageId: "om_new" });
    await runApprovalChanged(edited);

    expect(db.rows("integration_deliveries").find((d) => d.id === waiting.id)).toMatchObject({
      status: "superseded",
      last_error: "request changed before delivery",
    });
    expect(deliveries("decision_update")).toHaveLength(0); // never reached anyone: nothing to patch
    const fresh = deliveries("approval_card").filter((d) => d.id !== waiting.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].status).toBe("sent");
  });

  it("retires the tokens even when the connector is paused (security does not depend on the kill switch)", async () => {
    await raised();
    db.rows("integration_connectors")[0].status = "paused";
    edit();
    await runApprovalChanged(edited);
    expect(tokens().every((t) => t.used_at !== null)).toBe(true);
    expect(fake.calls.sends).toHaveLength(2); // nothing new went out
  });

  it("does not touch another request's cards or tokens", async () => {
    await raised();
    db.seed("action_tokens", [
      {
        id: "other",
        workspace_id: WS,
        delivery_id: "d",
        recipient_profile_id: ids.manager,
        approval_kind: "change_request",
        approval_id: "b0000000-0000-4000-8000-0000000000ff",
        approval_version: V1,
        token_hash: "h-other",
        expires_at: "2026-12-01T00:00:00.000Z",
        used_at: null,
      },
    ]);
    edit();
    await runApprovalChanged(edited);
    expect(tokens().find((t) => t.id === "other")?.used_at).toBeNull();
  });

  it("a card whose send was IN FLIGHT when the edit landed gets its replacement as soon as that send settles", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    let first = true;
    fake.state.sendResult = async () => {
      if (first) {
        first = false;
        edit(); // the requester edits while the first card is out...
        await runApprovalChanged(edited); // ...and the edit's fan-out runs right then
      }
      return { ok: true, externalMessageId: `om_${fake.calls.sends.length}` };
    };

    await runApprovalRequested(crEvent);

    const cards = deliveries("approval_card");
    expect(cards).toHaveLength(2); // the in-flight old card, and its replacement
    expect(cards.every((d) => d.status === "sent")).toBe(true);
    // the old card ends patched to 'updated', the new one is the live card
    expect(fake.calls.updates).toHaveLength(1);
    expect((fake.calls.updates[0].body as { card: string }).card).toBe("changed");
    const live = tokens().filter((t) => t.used_at === null);
    expect(live).toHaveLength(1);
    expect(live[0].approval_version).toBe(V2);
    expect(fake.calls.cards.at(-1)?.ev.title).toBe(edited.title);
  });
});

describe("per-approver hourly card budget", () => {
  const OLD_CARD = (i: number, recipient: string, over: Record<string, unknown> = {}) => ({
    id: `budget-${recipient.slice(-1)}-${i}`,
    workspace_id: WS,
    connector_id: CONNECTOR_ID,
    kind: "approval_card",
    approval_kind: "task_deletion",
    approval_id: `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    recipient_profile_id: recipient,
    external_target: "ou_x",
    status: "sent",
    attempts: 1,
    payload: {},
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    ...over,
  });
  const seedCards = (recipient: string, n: number, over: Record<string, unknown> = {}) =>
    db.seed("integration_deliveries", Array.from({ length: n }, (_, i) => OLD_CARD(i, recipient, over)));
  const notices = () => deliveries("bot_reply").filter((d) => d.payload.notice === "backlog");

  it("sends cards up to the budget, then ONE roll-up message instead of more cards", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    linkIdentity(db, ids.manager2, "ou_mia");
    seedCards(ids.manager, CARD_BUDGET_PER_HOUR);

    await runApprovalRequested(event);

    // the over-budget approver got no card, the other approver did
    expect(deliveries("approval_card").filter((d) => d.approval_id === event.id && d.recipient_profile_id === ids.manager)).toHaveLength(0);
    expect(deliveries("approval_card").filter((d) => d.approval_id === event.id && d.recipient_profile_id === ids.manager2)).toHaveLength(1);
    expect(fake.calls.sends.filter((s) => s.receiveId === "ou_mia")).toHaveLength(1);
    expect(fake.calls.cards.map((c) => c.ev.id)).toEqual([event.id]); // one real card rendered: Mia's
    // ...and Max got the roll-up
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ recipient_profile_id: ids.manager, status: "sent", external_target: "ou_max" });
    expect(fake.calls.sends.find((s) => s.receiveId === "ou_max")?.body).toMatchObject({ card: "backlog", limit: CARD_BUDGET_PER_HOUR });
    expect(db.rows("action_tokens")).toHaveLength(1); // a roll-up carries no token
  });

  it("queues the roll-up once per hour however many requests follow", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    seedCards(ids.manager, CARD_BUDGET_PER_HOUR);
    for (const n of [1, 2, 3]) {
      await runApprovalRequested({ ...event, id: `d0000000-0000-4000-8000-00000000000${n}` });
    }
    expect(notices()).toHaveLength(1);
    expect(fake.calls.sends).toHaveLength(1);
  });

  it("counts only the last hour, and not cards that never went out", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    seedCards(ids.manager, CARD_BUDGET_PER_HOUR, { created_at: new Date(Date.now() - 2 * 3600_000).toISOString() }); // too old
    await runApprovalRequested(event);
    expect(notices()).toHaveLength(0);
    expect(fake.calls.cards).toHaveLength(1);
  });

  it("does not count superseded cards against the budget", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    seedCards(ids.manager, CARD_BUDGET_PER_HOUR, { status: "superseded" });
    await runApprovalRequested(event);
    expect(fake.calls.cards).toHaveLength(1);
  });

  it("starts a fresh budget the next hour", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    seedCards(ids.manager, CARD_BUDGET_PER_HOUR);
    await runApprovalRequested(event);
    expect(fake.calls.cards).toHaveLength(0);

    vi.setSystemTime(new Date(Date.now() + 61 * 60_000));
    seedPendingRequests(db, "d0000000-0000-4000-8000-0000000000aa");
    await runApprovalRequested({ ...event, id: "d0000000-0000-4000-8000-0000000000aa" });
    expect(fake.calls.cards).toHaveLength(1);
  });

  it("is per approver: one person over budget does not hold back the others", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    linkIdentity(db, ids.manager2, "ou_mia");
    seedCards(ids.manager2, CARD_BUDGET_PER_HOUR);
    await runApprovalRequested(event);
    expect(fake.calls.sends.map((s) => s.receiveId).sort()).toEqual(["ou_max", "ou_mia"]); // Max: card, Mia: roll-up
    expect(fake.calls.cards).toHaveLength(1);
  });
});
