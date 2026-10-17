import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));

import { clearAdapters, insertDeliveries, registerAdapter } from "./deliveries";
import {
  CRON_DEADLINE_MS,
  CRON_DRAIN_LIMIT,
  RETENTION,
  digestDue,
  isoWeekStart,
  runCron,
  sendWeeklyDigestIfDue,
  verifyCronAuth,
} from "./cron";
import { LARK_CALL_TIMEOUT_MS } from "./lark/client";
import type { ConnectorRow } from "./types";
import {
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

// 2026-10-16 is a Friday (UTC weekday 5).
const FRIDAY = new Date("2026-10-16T01:00:00.000Z");
const DAY = 24 * 3600_000;

let db: FakeDb;
let fake: ReturnType<typeof createFakeAdapter>;

const digestConfig = (over: Record<string, unknown> = {}) => ({
  region: "lark",
  appId: "cli_a1b2c3",
  mode: "webhook",
  approvals: { enabled: true },
  digest: { enabled: true, chatId: "oc_team", weekday: 5, ...over },
});
const setConfig = (config: unknown) => {
  db.rows("integration_connectors")[0].config = config;
};
const digests = () => db.rows("integration_deliveries").filter((d) => d.kind === "digest") as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FRIDAY);
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  setConfig(digestConfig());
  db.seed("projects", [{ id: "p1", workspace_id: WS, name: "Apollo", rag_status: "red", is_locked: false }]);
  fake = createFakeAdapter();
  clearAdapters();
  registerAdapter(fake.adapter);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("verifyCronAuth", () => {
  it("accepts exactly the configured secret as a Bearer token", () => {
    expect(verifyCronAuth("Bearer s3cret-value", "s3cret-value")).toBe(true);
    expect(verifyCronAuth("bearer s3cret-value", "s3cret-value")).toBe(true);
  });

  it("rejects a wrong, partial, longer or differently-cased secret", () => {
    for (const bad of ["Bearer wrong", "Bearer s3cret", "Bearer s3cret-value-and-more", "Bearer S3CRET-VALUE"]) {
      expect(verifyCronAuth(bad, "s3cret-value")).toBe(false);
    }
  });

  it("rejects a missing or malformed Authorization header", () => {
    expect(verifyCronAuth(null, "s3cret-value")).toBe(false);
    expect(verifyCronAuth("", "s3cret-value")).toBe(false);
    expect(verifyCronAuth("s3cret-value", "s3cret-value")).toBe(false); // no Bearer scheme
    expect(verifyCronAuth("Basic s3cret-value", "s3cret-value")).toBe(false);
    expect(verifyCronAuth("Bearer", "s3cret-value")).toBe(false);
  });

  it("fails CLOSED when CRON_SECRET is not configured — an empty secret authorises nobody", () => {
    expect(verifyCronAuth("Bearer anything", undefined)).toBe(false);
    expect(verifyCronAuth("Bearer anything", "")).toBe(false);
    expect(verifyCronAuth("Bearer ", "")).toBe(false);
  });

  it("ignores whitespace around the configured secret (a trailing newline pasted into the host env UI)", () => {
    expect(verifyCronAuth("Bearer s3cret-value", "s3cret-value\n")).toBe(true);
    expect(verifyCronAuth("Bearer s3cret-value", "  s3cret-value ")).toBe(true);
    expect(verifyCronAuth("Bearer anything", "\n")).toBe(false); // whitespace-only is still "unset"
    expect(verifyCronAuth("Bearer s3cret-valu", "s3cret-value\n")).toBe(false);
  });

  it("reads CRON_SECRET from the environment by default", () => {
    vi.stubEnv("CRON_SECRET", "from-env");
    expect(verifyCronAuth("Bearer from-env")).toBe(true);
    expect(verifyCronAuth("Bearer other")).toBe(false);
    vi.stubEnv("CRON_SECRET", "");
    expect(verifyCronAuth("Bearer from-env")).toBe(false);
  });
});

describe("isoWeekStart", () => {
  it("is the Monday 00:00 UTC of the ISO week", () => {
    expect(isoWeekStart(new Date("2026-10-14T15:30:00Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z"); // Wed
    expect(isoWeekStart(new Date("2026-10-12T00:00:00Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z"); // Mon
    expect(isoWeekStart(new Date("2026-10-18T23:59:59Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z"); // Sun
    expect(isoWeekStart(new Date("2027-01-03T10:00:00Z")).toISOString()).toBe("2026-12-28T00:00:00.000Z"); // year boundary
  });
});

describe("runCron — retries", () => {
  it("drains deliveries that are due and leaves the ones that are not", async () => {
    setConfig(digestConfig({ enabled: false }));
    const [due, later] = await insertDeliveries(WS, CONNECTOR_ID, [
      { kind: "bot_reply", external_target: "ou_a", payload: { receiveIdType: "open_id", body: { text: "a" } } },
      { kind: "bot_reply", external_target: "ou_b", payload: { receiveIdType: "open_id", body: { text: "b" } } },
    ]);
    const rows = db.rows("integration_deliveries");
    rows.find((r) => r.id === due.id)!.status = "retry";
    rows.find((r) => r.id === due.id)!.next_attempt_at = new Date(Date.now() - 60_000).toISOString();
    rows.find((r) => r.id === later.id)!.status = "retry";
    rows.find((r) => r.id === later.id)!.next_attempt_at = new Date(Date.now() + 3600_000).toISOString();

    const summary = await runCron({ now: new Date() });

    expect(summary.connectors).toBe(1);
    expect(summary.deliveries.sent).toBe(1);
    expect(fake.calls.sends.map((s) => s.receiveId)).toEqual(["ou_a"]);
    expect(rows.find((r) => r.id === later.id)!.status).toBe("retry");
  });

  it("skips paused connectors entirely (kill switch), leaving their queue alone", async () => {
    db.rows("integration_connectors")[0].status = "paused";
    await insertDeliveries(WS, CONNECTOR_ID, [{ kind: "bot_reply", external_target: "ou_a", payload: { receiveIdType: "open_id", body: {} } }]);

    const summary = await runCron({ now: new Date() });

    expect(summary.connectors).toBe(0);
    expect(fake.calls.sends).toHaveLength(0);
    expect(digests()).toHaveLength(0);
  });
});

describe("runCron — weekly digest", () => {
  it("posts the digest on the configured weekday, audited once, and only once per ISO week", async () => {
    const first = await runCron({ now: new Date() });

    expect(first.digests).toEqual({ sent: 1, skipped: 0, queued: 0, failed: 0 });
    expect(fake.calls.sends).toHaveLength(1);
    expect(fake.calls.sends[0]).toMatchObject({ receiveIdType: "chat_id", receiveId: "oc_team" });
    expect(digests()).toHaveLength(1);
    expect(digests()[0].payload.trigger).toBe("scheduled");

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditMock.mock.calls[0][0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(audit).toMatchObject({
      workspaceId: WS,
      action: "integration.digest.send",
      targetType: "integration_connector",
      targetId: CONNECTOR_ID,
      // the group chat id is masked: the audit stream is readable by every member
      after: { trigger: "scheduled", chat_id: "oc…", week_start: "2026-10-12" },
    });
    expect(audit.actor).toMatchObject({ viaConnectorId: CONNECTOR_ID, channel: "lark", workspaceId: WS });

    // same day, and the rest of the week, nothing more is sent
    const again = await runCron({ now: new Date() });
    expect(again.digests.skipped).toBe(1);
    vi.setSystemTime(new Date(Date.now() + 2 * DAY)); // Sunday, same ISO week, weekday differs anyway
    await runCron({ now: new Date() });
    expect(digests()).toHaveLength(1);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
  });

  it("sends again the next ISO week", async () => {
    await runCron({ now: new Date() });
    vi.setSystemTime(new Date(FRIDAY.getTime() + 7 * DAY));
    await runCron({ now: new Date() });
    expect(digests()).toHaveLength(2);
    expect(writeAuditMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing on other weekdays — and does not 'make up' a missed day when enabled midweek", async () => {
    setConfig(digestConfig({ weekday: 1 })); // Monday; today is Friday
    db.rows("integration_connectors")[0].updated_at = "2026-10-14T10:00:00.000Z"; // switched on / rescheduled on Wednesday, after Monday had passed
    const summary = await runCron({ now: new Date() });
    expect(summary.digests).toEqual({ sent: 0, skipped: 1, queued: 0, failed: 0 });
    expect(digests()).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("does nothing when the digest is disabled or has no group chat", async () => {
    setConfig(digestConfig({ enabled: false }));
    await runCron({ now: new Date() });
    setConfig(digestConfig({ chatId: null }));
    await runCron({ now: new Date() });
    expect(digests()).toHaveLength(0);
  });

  it("a manual 'send now' does not use up the weekly slot", async () => {
    await insertDeliveries(WS, CONNECTOR_ID, [{ kind: "digest", external_target: "oc_team", payload: { data: {}, trigger: "manual" } }]);
    db.rows("integration_deliveries")[0].status = "sent";
    await runCron({ now: new Date() });
    expect(digests().filter((d) => d.payload.trigger === "scheduled")).toHaveLength(1);
  });

  it("a digest whose send failed stays queued for retry and is not re-queued the next day", async () => {
    fake.state.sendResult = async () => ({ ok: false, retryable: true, error: "503" });
    const first = await runCron({ now: new Date() });
    expect(first.digests.failed).toBe(1);
    expect(digests()[0].status).toBe("retry");

    fake.state.sendResult = async () => ({ ok: true, externalMessageId: "om_digest" });
    vi.setSystemTime(new Date(Date.now() + DAY));
    const next = await runCron({ now: new Date() });
    expect(next.deliveries.sent).toBe(1); // the retry went out
    expect(digests()).toHaveLength(1); // ...with no second digest queued
  });

  it("is fail-closed: if the audit row cannot be written nothing is queued or sent", async () => {
    writeAuditMock.mockRejectedValueOnce(new Error("audit down"));
    const summary = await runCron({ now: new Date() });
    expect(summary.digests.failed).toBe(1);
    expect(digests()).toHaveLength(0);
    expect(fake.calls.sends).toHaveLength(0);
  });

  it("one connector's failure does not starve the others", async () => {
    db.seed("integration_connectors", [
      connectorRow({ id: "second-connector", workspace_id: OTHER_WS, name: "Other Lark", config: digestConfig({ chatId: "oc_other" }) as never }) as never,
    ]);
    db.seed("workspaces", [{ id: OTHER_WS, name: "Other Org" }]);
    writeAuditMock.mockRejectedValueOnce(new Error("audit down")); // first connector's audit fails

    const summary = await runCron({ now: new Date() });

    expect(summary.connectors).toBe(2);
    expect(summary.digests).toEqual({ sent: 1, skipped: 0, queued: 0, failed: 1 });
    expect(fake.calls.sends.map((s) => s.receiveId)).toHaveLength(1);
  });

  it("only gathers the connector's own workspace data", async () => {
    db.seed("projects", [{ id: "p-other", workspace_id: OTHER_WS, name: "Secret Other Org Project", rag_status: "red", is_locked: false }]);
    await runCron({ now: new Date() });
    const payload = JSON.stringify(digests()[0].payload);
    expect(payload).toContain("Apollo");
    expect(payload).not.toContain("Secret Other Org Project");
  });
});

describe("runCron — the weekly digest is claimed atomically", () => {
  it("three concurrent ticks (or a cron event delivered three times) queue ONE digest and write ONE audit row", async () => {
    await Promise.all([runCron({ now: new Date() }), runCron({ now: new Date() }), runCron({ now: new Date() })]);

    expect(digests()).toHaveLength(1);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(fake.calls.sends).toHaveLength(1);
    expect(digests()[0]).toMatchObject({ status: "sent" });
    expect(digests()[0].payload).toMatchObject({ trigger: "scheduled", week_start: "2026-10-12" });
    expect(digests()[0].payload.held).toBeUndefined();
  });

  it("keys the week by the Monday of the ISO week in the stored payload", async () => {
    await runCron({ now: new Date() });
    expect(digests()[0].payload.week_start).toBe("2026-10-12");
  });
});

describe("runCron — a tick that died mid-way does not lose the week", () => {
  const heldRow = (over: Record<string, unknown> = {}) => ({
    id: "held-digest",
    workspace_id: WS,
    connector_id: CONNECTOR_ID,
    kind: "digest",
    status: "pending",
    attempts: 0,
    next_attempt_at: FRIDAY.toISOString(),
    created_at: FRIDAY.toISOString(),
    external_target: "oc_team",
    payload: { trigger: "scheduled", week_start: "2026-10-12", held: true },
    locked_until: new Date(FRIDAY.getTime() - 60_000).toISOString(), // the dead tick's lease ran out
    ...over,
  });

  it("resumes a claimed-but-unfinished digest: audits it, fills it and sends it once", async () => {
    db.seed("integration_deliveries", [heldRow()]);

    const summary = await runCron({ now: new Date() });

    expect(summary.digests.sent).toBe(1);
    expect(digests()).toHaveLength(1); // the claim was completed, not duplicated
    expect(digests()[0]).toMatchObject({ id: "held-digest", status: "sent" });
    expect(digests()[0].payload.held).toBeUndefined();
    expect(digests()[0].payload.data).toBeDefined();
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ after: { week_start: "2026-10-12", catch_up: true } });
    expect(fake.calls.sends).toHaveLength(1);
  });

  it("resumes on a LATER day of the same week too (the next daily tick retries the unsent digest)", async () => {
    db.seed("integration_deliveries", [heldRow()]);
    vi.setSystemTime(new Date(FRIDAY.getTime() + DAY)); // Saturday: not the digest weekday
    const summary = await runCron({ now: new Date() });
    expect(summary.digests.sent).toBe(1);
    expect(digests()[0]).toMatchObject({ id: "held-digest", status: "sent" });
  });

  it("leaves a claim alone while its owner's lease is still live (another tick is working on it)", async () => {
    db.seed("integration_deliveries", [heldRow({ locked_until: new Date(FRIDAY.getTime() + 60_000).toISOString() })]);

    const summary = await runCron({ now: new Date() });

    expect(summary.digests.skipped).toBe(1);
    expect(writeAuditMock).not.toHaveBeenCalled();
    expect(fake.calls.sends).toHaveLength(0);
    expect(digests()[0].payload.held).toBe(true);
  });

  it("drops a previous week's abandoned claim instead of sending last week's digest late, then queues this week's", async () => {
    db.seed("integration_deliveries", [heldRow({ payload: { trigger: "scheduled", week_start: "2026-10-05", held: true } })]);

    const summary = await runCron({ now: new Date() });

    expect(db.rows("integration_deliveries").find((d) => d.id === "held-digest")).toBeUndefined();
    expect(summary.digests.sent).toBe(1);
    expect(digests()).toHaveLength(1);
    expect(digests()[0].payload.week_start).toBe("2026-10-12");
  });

  it("frees the slot when the audit write fails, so the next tick can try again", async () => {
    writeAuditMock.mockRejectedValueOnce(new Error("audit down"));
    const first = await runCron({ now: new Date() });
    expect(first.digests.failed).toBe(1);
    expect(digests()).toHaveLength(0);

    const second = await runCron({ now: new Date() });
    expect(second.digests.sent).toBe(1);
    expect(digests()).toHaveLength(1);
  });

  it("never sends a held (unaudited) digest through a plain drain", async () => {
    db.seed("integration_deliveries", [heldRow({ locked_until: null, next_attempt_at: new Date(FRIDAY.getTime() - 1000).toISOString() })]);
    setConfig(digestConfig({ enabled: false })); // no digest step this tick: only the drain runs
    await runCron({ now: new Date() });
    expect(fake.calls.sends).toHaveLength(0);
  });
});

describe("runCron — catching up a missed digest day", () => {
  const setUpdatedAt = (iso: string) => {
    db.rows("integration_connectors")[0].updated_at = iso;
  };

  it("sends a digest whose weekday already passed this week when the schedule predates that day", async () => {
    setConfig(digestConfig({ weekday: 1 })); // Monday; today is Friday; the fixture's config dates from 1 Oct
    const summary = await runCron({ now: new Date() });
    expect(summary.digests.sent).toBe(1);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ after: { week_start: "2026-10-12", catch_up: true } });
    // ...and only once for the week
    expect((await runCron({ now: new Date() })).digests.skipped).toBe(1);
    expect(digests()).toHaveLength(1);
  });

  it("does not catch up when the schedule was set after that day had begun", async () => {
    setConfig(digestConfig({ weekday: 1 }));
    setUpdatedAt("2026-10-12T09:00:00.000Z"); // rescheduled on the Monday itself, after it started
    expect((await runCron({ now: new Date() })).digests.skipped).toBe(1);
    expect(digests()).toHaveLength(0);
  });

  it("does not send early for a weekday later in the week", async () => {
    setConfig(digestConfig({ weekday: 6 })); // Saturday
    expect((await runCron({ now: new Date() })).digests.skipped).toBe(1);
    expect(digests()).toHaveLength(0);
  });

  it("treats Sunday as the LAST day of the ISO week", async () => {
    setConfig(digestConfig({ weekday: 0 })); // Sunday
    expect(digestDue({ updated_at: "2026-10-01T00:00:00.000Z" }, 0, new Date("2026-10-18T01:00:00Z"))).toBe("today");
    expect(digestDue({ updated_at: "2026-10-01T00:00:00.000Z" }, 0, new Date("2026-10-16T01:00:00Z"))).toBe("no");
    expect(digestDue({ updated_at: "2026-10-01T00:00:00.000Z" }, 1, new Date("2026-10-18T01:00:00Z"))).toBe("catch_up");
  });
});

describe("runCron — bounded in time and concurrency", () => {
  const THIRD_WS = "33333333-3333-4333-8333-333333333333";

  function addConnector(id: string, workspaceId: string) {
    db.seed("workspaces", [{ id: workspaceId, name: `Org ${id}` }]);
    db.seed("integration_connectors", [
      connectorRow({ id, workspace_id: workspaceId, name: `Lark ${id}`, config: digestConfig({ enabled: false }) as never }) as never,
    ]);
  }
  const reply = (connectorId: string, workspaceId: string, target: string) =>
    insertDeliveries(workspaceId, connectorId, [
      { kind: "bot_reply", external_target: target, payload: { receiveIdType: "open_id", body: { t: target } } },
    ]);

  it("a connector whose platform hangs does not starve the others, and is abandoned at the deadline", async () => {
    setConfig(digestConfig({ enabled: false }));
    addConnector("conn-b", OTHER_WS);
    addConnector("conn-c", THIRD_WS);
    await reply(CONNECTOR_ID, WS, "ou_slow");
    await reply("conn-b", OTHER_WS, "ou_b");
    await reply("conn-c", THIRD_WS, "ou_c");
    fake.state.sendResult = async () => ({ ok: true, externalMessageId: "om_ok" });
    const send = fake.adapter.send;
    fake.adapter.send = (connector, secrets, msg) =>
      msg.receiveId === "ou_slow" ? new Promise<never>(() => {}) : send(connector, secrets, msg);

    const pending = runCron({ now: new Date(), deadlineMs: 2_000, concurrency: 2 });
    await vi.advanceTimersByTimeAsync(60_000);
    const summary = await pending;

    expect(summary.connectors).toBe(3);
    expect(summary.timedOut).toBe(1);
    expect(summary.deliveries.sent).toBe(2);
    const partial = db.rows("integration_cron_state").filter((r) => (r.last_summary as { partial: boolean }).partial);
    expect(partial.map((r) => r.connector_id)).toEqual([CONNECTOR_ID]);
    expect(fake.calls.sends.map((s) => s.receiveId).sort()).toEqual(["ou_b", "ou_c"]);
  });

  it("stops starting connectors at the deadline and leaves their queue for the next tick", async () => {
    setConfig(digestConfig({ enabled: false }));
    await reply(CONNECTOR_ID, WS, "ou_a");

    const summary = await runCron({ now: new Date(), deadlineMs: -1 });

    expect(summary.skippedForDeadline).toBe(1);
    expect(fake.calls.sends).toHaveLength(0);
    expect(db.rows("integration_deliveries")[0].status).toBe("pending");
    expect(db.rows("integration_cron_state")[0].last_summary).toMatchObject({ partial: true }); // the admin view can tell this run was cut short

    expect((await runCron({ now: new Date() })).deliveries.sent).toBe(1); // the next tick delivers it
  });

  it("still queues the week's digest when the deadline has already passed (no platform call needed)", async () => {
    const summary = await runCron({ now: new Date(), deadlineMs: -1 });

    expect(summary.digests).toEqual({ sent: 0, skipped: 0, queued: 1, failed: 0 });
    expect(digests()).toHaveLength(1);
    expect(digests()[0].status).toBe("pending");
    expect(writeAuditMock).toHaveBeenCalledTimes(1);

    // the next tick delivers it without queueing a second one
    const next = await runCron({ now: new Date() });
    expect(next.deliveries.sent).toBe(1);
    expect(digests()).toHaveLength(1);
    expect(fake.calls.sends).toHaveLength(1);
  });

  it("serves the connector with the oldest due backlog first", async () => {
    setConfig(digestConfig({ enabled: false }));
    addConnector("conn-b", OTHER_WS);
    const [mine] = await reply(CONNECTOR_ID, WS, "ou_newer");
    const [theirs] = await reply("conn-b", OTHER_WS, "ou_older");
    const rows = db.rows("integration_deliveries");
    rows.find((r) => r.id === mine.id)!.next_attempt_at = "2026-10-16T00:50:00.000Z";
    rows.find((r) => r.id === theirs.id)!.next_attempt_at = "2026-10-15T00:50:00.000Z";

    await runCron({ now: new Date(), concurrency: 1 });

    expect(fake.calls.sends.map((s) => s.receiveId)).toEqual(["ou_older", "ou_newer"]);
  });

  it("drains a connector's backlog page by page, not just the first page", async () => {
    setConfig(digestConfig({ enabled: false }));
    await insertDeliveries(
      WS,
      CONNECTOR_ID,
      Array.from({ length: CRON_DRAIN_LIMIT + 20 }, (_, i) => ({
        kind: "bot_reply" as const,
        external_target: `ou_${i}`,
        payload: { receiveIdType: "open_id", body: {} },
      })),
    );
    const summary = await runCron({ now: new Date() });
    expect(summary.deliveries.sent).toBe(CRON_DRAIN_LIMIT + 20);
  });

  it("keeps the deadline well under the route's maxDuration, with room for one platform call", () => {
    expect(CRON_DEADLINE_MS + LARK_CALL_TIMEOUT_MS + 5_000).toBeLessThan(60_000);
  });
});

describe("runCron — retention", () => {
  const OLD = "2026-06-01T00:00:00.000Z"; // > 60 days before 16 Oct
  const RECENT = "2026-10-10T00:00:00.000Z";
  const base = { workspace_id: WS, connector_id: CONNECTOR_ID, kind: "bot_reply", attempts: 1, next_attempt_at: OLD, payload: {} };
  const surviving = () => db.rows("integration_deliveries").map((r) => r.id).sort();

  beforeEach(() => setConfig(digestConfig({ enabled: false })));

  it("deletes finished deliveries past the window and keeps everything else", async () => {
    db.seed("integration_deliveries", [
      { ...base, id: "old-sent", status: "sent", created_at: OLD },
      { ...base, id: "old-dead", status: "dead", created_at: OLD },
      { ...base, id: "old-superseded", status: "superseded", created_at: OLD },
      { ...base, id: "recent-sent", status: "sent", created_at: RECENT },
      // not terminal: never pruned, however old
      { ...base, id: "old-retry", status: "retry", created_at: OLD, next_attempt_at: "2099-01-01T00:00:00.000Z" },
      { ...base, id: "old-pending-leased", status: "pending", created_at: OLD, next_attempt_at: "2099-01-01T00:00:00.000Z" },
    ]);

    const summary = await runCron({ now: new Date() });

    expect(summary.pruned.deliveries).toBe(3);
    expect(surviving()).toEqual(["old-pending-leased", "old-retry", "recent-sent"]);
  });

  it("deletes action tokens only well after they expired", async () => {
    const token = (id: string, expires_at: string) => ({
      id,
      workspace_id: WS,
      delivery_id: "d",
      recipient_profile_id: ids.manager,
      approval_kind: "change_request",
      approval_id: ids.approval,
      token_hash: `h-${id}`,
      expires_at,
      used_at: null,
    });
    db.seed("action_tokens", [
      token("expired-long-ago", "2026-09-01T00:00:00.000Z"),
      token("expired-last-week", "2026-10-09T00:00:00.000Z"),
      token("still-valid", "2026-10-20T00:00:00.000Z"),
    ]);

    const summary = await runCron({ now: new Date() });

    expect(summary.pruned.action_tokens).toBe(1);
    expect(db.rows("action_tokens").map((t) => t.id).sort()).toEqual(["expired-last-week", "still-valid"]);
  });

  it("deletes completed inbound idempotency rows past the window, keeps unfinished and recent ones", async () => {
    const inbound = (id: string, received_at: string, outcome: unknown) => ({
      id,
      workspace_id: WS,
      connector_id: CONNECTOR_ID,
      external_event_id: id,
      action: "approve",
      outcome,
      received_at,
    });
    db.seed("inbound_actions", [
      inbound("old-done", "2026-06-01T00:00:00.000Z", { status: "decided" }),
      inbound("old-unfinished", "2026-06-01T00:00:00.000Z", null),
      inbound("recent-done", RECENT, { status: "decided" }),
    ]);

    const summary = await runCron({ now: new Date() });

    expect(summary.pruned.inbound_actions).toBe(1);
    expect(db.rows("inbound_actions").map((r) => r.id).sort()).toEqual(["old-unfinished", "recent-done"]);
  });

  it("deletes at most one bounded batch per table per tick", async () => {
    db.seed(
      "integration_deliveries",
      Array.from({ length: RETENTION.batch + 25 }, (_, i) => ({ ...base, id: `old-${i}`, status: "sent", created_at: OLD })),
    );
    const first = await runCron({ now: new Date() });
    expect(first.pruned.deliveries).toBe(RETENTION.batch);
    const second = await runCron({ now: new Date() });
    expect(second.pruned.deliveries).toBe(25);
    expect(db.rows("integration_deliveries")).toHaveLength(0);
  });

  it("is workspace-scoped and also reaches a revoked connector's history", async () => {
    db.seed("workspaces", [{ id: OTHER_WS, name: "Other Org" }]);
    db.seed("integration_connectors", [connectorRow({ id: "revoked-conn", workspace_id: OTHER_WS, status: "revoked" }) as never]);
    db.seed("integration_deliveries", [
      { ...base, id: "mine-old", status: "sent", created_at: OLD },
      { ...base, id: "theirs-old", workspace_id: OTHER_WS, connector_id: "revoked-conn", status: "sent", created_at: OLD },
    ]);
    const summary = await runCron({ now: new Date() });
    expect(summary.pruned.deliveries).toBe(2);
  });

  it("never touches the audit log, and a failing prune does not fail the tick", async () => {
    db.seed("audit_log", [{ id: "audit-1", workspace_id: WS, action: "integration.digest.send", created_at: OLD }]);
    db.seed("integration_deliveries", [{ ...base, id: "old-sent", status: "sent", created_at: OLD }]);
    db.failNext({ table: "integration_deliveries", op: "delete", error: { message: "boom" } });

    const summary = await runCron({ now: new Date() });

    expect(summary.pruned.deliveries).toBe(0);
    expect(db.rows("audit_log")).toHaveLength(1);
    expect(db.log.filter((l) => l.table === "audit_log")).toHaveLength(0);
  });
});

describe("runCron — operator visibility", () => {
  it("records what it did for each connector it processed", async () => {
    setConfig(digestConfig({ enabled: false }));
    await insertDeliveries(WS, CONNECTOR_ID, [
      { kind: "bot_reply", external_target: "ou_a", payload: { receiveIdType: "open_id", body: {} } },
    ]);

    await runCron({ now: new Date() });
    const [state] = db.rows("integration_cron_state");
    expect(state).toMatchObject({ workspace_id: WS, connector_id: CONNECTOR_ID });
    expect(state.last_run_at).toBe(new Date().toISOString());
    expect(state.last_summary).toMatchObject({ claimed: 1, sent: 1, dead: 0, digest: "skipped", partial: false });

    vi.setSystemTime(new Date(Date.now() + DAY));
    await runCron({ now: new Date() });
    expect(db.rows("integration_cron_state")).toHaveLength(1); // updated in place
    expect(db.rows("integration_cron_state")[0].last_summary).toMatchObject({ claimed: 0 });
  });

  it("a failed bookkeeping write never fails the tick", async () => {
    setConfig(digestConfig({ enabled: false }));
    db.failNext({ table: "integration_cron_state", op: "update", error: { message: "table missing" } });
    await expect(runCron({ now: new Date() })).resolves.toMatchObject({ connectors: 1 });
  });
});

describe("sendWeeklyDigestIfDue (standalone)", () => {
  it("queues the digest and sends it, then skips for the rest of the week", async () => {
    const connector = db.rows("integration_connectors")[0] as unknown as ConnectorRow;
    const cfg = { ...connector, config: digestConfig() as never };
    expect(await sendWeeklyDigestIfDue(cfg, new Date())).toBe("sent");
    expect(await sendWeeklyDigestIfDue(cfg, new Date())).toBe("skipped");
    expect(fake.calls.sends).toHaveLength(1);
  });
});
