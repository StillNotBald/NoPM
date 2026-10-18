import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit/write")>()),
  writeAudit: writeAuditMock,
}));
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));

import { clearAdapters } from "./deliveries";
import { runCron } from "./cron";
import { FakeDb, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "./test-support";
import { gatherDigestData } from "./digest-data";
import { buildDigestCard } from "./lark/cards";

// Wednesday 2026-10-21, 09:07 in Kuala Lumpur.
const NOW = new Date("2026-10-21T01:07:00.000Z");
const DAY = 24 * 3600_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let db: FakeDb;
const stale = (rows: Record<string, unknown>[]) => rows.filter((r) => r.kind === "stale");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pm.example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  clearAdapters();
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  db.seed("projects", [{ id: "p1", workspace_id: WS, code: "APO", name: "Apollo", owner_id: ids.manager, rag_status: "green", is_locked: false }]);
  db.seed("resource_members", [{ id: "rm-mo", workspace_id: WS, name: "Mo", profile_id: ids.member }]);
  db.seed("tasks", [{ id: "t1", workspace_id: WS, project_id: "p1", name: "Stuck", status_type: "started", assignee_id: "rm-mo", updated_at: ago(21) }]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runCron nudge step (R-141)", () => {
  it("nudges a stale item once, and a second tick the same day sends nothing", async () => {
    const first = await runCron({ now: NOW });
    expect(first.nudges).toMatchObject({ workspaces: 1, staleNudged: 1, failed: 0 });
    expect(db.rows("notifications").filter((n) => n.type === "item.stale")).toHaveLength(1);
    expect(stale(db.rows("nudge_log"))).toHaveLength(1);
    expect(writeAuditMock.mock.calls.filter((c) => c[0].action === "nudge.sent")).toHaveLength(1);

    const second = await runCron({ now: NOW });
    expect(second.nudges.staleNudged).toBe(0);
    expect(db.rows("notifications").filter((n) => n.type === "item.stale")).toHaveLength(1);
    expect(stale(db.rows("nudge_log"))).toHaveLength(1);
  });

  it("sends nothing when nudges are switched off", async () => {
    db.rows("workspaces").find((w) => w.id === WS)!.nudges_enabled = false;
    const summary = await runCron({ now: NOW });
    expect(summary.nudges.staleNudged).toBe(0);
    expect(db.rows("notifications").filter((n) => n.type === "item.stale")).toHaveLength(0);
    expect(stale(db.rows("nudge_log"))).toHaveLength(0);
  });

  it("runs for a workspace with no connector at all", async () => {
    db.tables.integration_connectors = [];
    const summary = await runCron({ now: NOW });
    expect(summary.connectors).toBe(0);
    expect(summary.nudges.staleNudged).toBe(1);
  });
});

describe("digest stale line (R-141)", () => {
  it("counts stale items with the workspace threshold and the card shows a Stale items line only when there are some", async () => {
    const data = await gatherDigestData(WS, { now: NOW });
    expect(data).toMatchObject({ staleItems: 1, staleDays: 14 });
    expect(JSON.stringify(buildDigestCard(data))).toContain("Stale items");

    db.rows("workspaces").find((w) => w.id === WS)!.stale_days = 30;
    const quiet = await gatherDigestData(WS, { now: NOW });
    expect(quiet.staleItems).toBe(0);
    expect(JSON.stringify(buildDigestCard(quiet))).not.toContain("Stale items");
  });
});
