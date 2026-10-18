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

// Wednesday 2026-10-21, 09:07 in Kuala Lumpur.
const NOW = new Date("2026-10-21T01:07:00.000Z");
const H = 3_600_000;
const at = (h: number) => new Date(NOW.getTime() + h * H).toISOString();

let db: FakeDb;

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
  db.seed("change_requests", [
    {
      id: "cr-late",
      workspace_id: WS,
      status: "raised",
      tier: "normal",
      reference_id: "CR-007",
      title: "Late one",
      raised_at: at(-60),
      created_at: at(-60),
      approval_deadline_at: at(-12),
      requested_principal_id: ids.requester,
    },
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runCron approval timer step (G3)", () => {
  it("escalates an overdue request once per day and reports it in the tick summary", async () => {
    const first = await runCron({ now: NOW });
    expect(first.approvals).toMatchObject({ workspaces: 1, escalated: 1, autoApproved: 0, failed: 0 });
    expect(db.rows("notifications").filter((n) => n.type === "approval.escalated").map((n) => n.recipient_id)).toEqual([ids.admin]);
    expect(writeAuditMock.mock.calls.filter((c) => c[0].action === "approval.timer_run")).toHaveLength(1);

    const second = await runCron({ now: NOW });
    expect(second.approvals.escalated).toBe(0);
    expect(db.rows("notifications").filter((n) => n.type === "approval.escalated")).toHaveLength(1);
  });

  it("a failing timer step never fails the tick", async () => {
    db.failNext({ table: "change_requests", op: "select", error: { message: "boom" }, times: 5 });
    const summary = await runCron({ now: NOW });
    expect(summary.approvals.failed).toBeGreaterThan(0);
    expect(summary.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
