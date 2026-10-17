import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));

import { SCHEDULER_STALE_MS, getConnectorHealth, isSchedulerStale } from "./health";
import { CONNECTOR_ID, FakeDb, WS } from "./test-support";

// F7 of the 2026-10-17 integration review: health honesty.

const NOW = new Date("2026-10-18T12:00:00.000Z");
const agoIso = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const H = 3_600_000;

let db: FakeDb;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = new FakeDb();
  state.db = db;
});

const delivery = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  workspace_id: WS,
  connector_id: CONNECTOR_ID,
  kind: "approval_card",
  status,
  attempts: 1,
  created_at: agoIso(48 * H),
  next_attempt_at: agoIso(48 * H),
  sent_at: null,
  last_error: null,
  payload: {},
  ...over,
});
const cronState = (lastRunAt: string) => ({
  connector_id: CONNECTOR_ID,
  workspace_id: WS,
  last_run_at: lastRunAt,
  last_summary: { claimed: 1, sent: 1, retried: 0, dead: 0, superseded: 0, digest: "skipped" },
});
const health = (createdAt: string | null = agoIso(30 * 24 * H)) =>
  getConnectorHealth(WS, CONNECTOR_ID, { now: NOW, connectorCreatedAt: createdAt });

describe("isSchedulerStale", () => {
  it("is stale only past 36 hours, counted from the last run", () => {
    expect(SCHEDULER_STALE_MS).toBe(36 * H);
    expect(isSchedulerStale(agoIso(35 * H), true, null, NOW)).toBe(false);
    expect(isSchedulerStale(agoIso(37 * H), true, null, NOW)).toBe(true);
  });
  it("counts a connector that never ran from its creation, so a new one is not flagged", () => {
    expect(isSchedulerStale(null, true, agoIso(2 * H), NOW)).toBe(false);
    expect(isSchedulerStale(null, true, agoIso(40 * H), NOW)).toBe(true);
  });
  it("is unknown (null), never a guess, when the state table is unavailable or nothing is dated", () => {
    expect(isSchedulerStale(null, false, agoIso(400 * H), NOW)).toBeNull();
    expect(isSchedulerStale(null, true, null, NOW)).toBeNull();
    expect(isSchedulerStale("not a date", true, null, NOW)).toBeNull();
  });
});

describe("getConnectorHealth — scheduler honesty", () => {
  it("flags a scheduler that stopped, with the state available", async () => {
    db.seed("integration_cron_state", [cronState(agoIso(50 * H))]);
    expect(await health()).toMatchObject({ scheduler_stale: true, cron_state_available: true, last_cron_at: agoIso(50 * H) });
  });

  it("does not flag a scheduler that ran yesterday", async () => {
    db.seed("integration_cron_state", [cronState(agoIso(20 * H))]);
    expect(await health()).toMatchObject({ scheduler_stale: false, cron_state_available: true });
  });

  it("a connector that has genuinely never run reads as stale once it is old enough, and not before", async () => {
    expect(await health(agoIso(30 * 24 * H))).toMatchObject({ last_cron_at: null, scheduler_stale: true, cron_state_available: true });
    expect(await health(agoIso(3 * H))).toMatchObject({ last_cron_at: null, scheduler_stale: false, cron_state_available: true });
  });

  it("separates 'state table missing' from 'never ran'", async () => {
    db.failNext({ table: "integration_cron_state", op: "select", error: { message: "relation does not exist" } });
    expect(await health()).toMatchObject({ last_cron_at: null, cron_state_available: false, scheduler_stale: null });
  });
});

describe("getConnectorHealth — last failure", () => {
  it("is the failure with the latest attempt, not the newest row", async () => {
    db.seed("integration_deliveries", [
      // created last, but its final attempt was weeks ago
      delivery("old-dead", "dead", { last_error: "weeks-old dead letter", created_at: agoIso(1 * H), next_attempt_at: agoIso(20 * 24 * H) }),
      // created earlier, but failed again this morning
      delivery("recent-retry", "retry", { last_error: "network error [ETIMEDOUT]", created_at: agoIso(30 * H), next_attempt_at: agoIso(-1 * H) }),
    ]);
    expect((await health())?.last_error).toBe("network error [ETIMEDOUT]");
  });

  it("ignores rows without an error and rows that are not failing", async () => {
    db.seed("integration_deliveries", [
      delivery("s", "sent", { last_error: "stale text on a sent row", sent_at: agoIso(H) }),
      delivery("r", "retry", { last_error: null }),
    ]);
    expect((await health())?.last_error).toBeNull();
  });
});

describe("getConnectorHealth — unknown is never zero", () => {
  it("returns null when the queue lookup itself fails", async () => {
    db.failNext({ table: "integration_deliveries", op: "select", error: { message: "db down" } });
    expect(await health()).toBeNull();
  });
});
