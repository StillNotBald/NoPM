import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));

import { clearAdapters, insertDeliveries, registerAdapter } from "./deliveries";
import { isoWeekStart, runCron, verifyCronAuth } from "./cron";
import {
  CONNECTOR_ID,
  FakeDb,
  OTHER_WS,
  TEST_ENCRYPTION_KEY,
  WS,
  connectorRow,
  createFakeAdapter,
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

    expect(first.digests).toEqual({ sent: 1, skipped: 0, failed: 0 });
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
      after: { trigger: "scheduled", chat_id: "oc_team", week_start: "2026-10-12" },
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
    const summary = await runCron({ now: new Date() });
    expect(summary.digests).toEqual({ sent: 0, skipped: 1, failed: 0 });
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
    expect(summary.digests).toEqual({ sent: 1, skipped: 0, failed: 1 });
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
