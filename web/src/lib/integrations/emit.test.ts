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
import { emitApprovalDecided, emitApprovalRequested, runApprovalDecided, runApprovalRequested } from "./emit";
import {
  CONNECTOR_ID,
  FakeDb,
  OTHER_WS,
  TEST_ENCRYPTION_KEY,
  WS,
  createFakeAdapter,
  ids,
  linkIdentity,
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
