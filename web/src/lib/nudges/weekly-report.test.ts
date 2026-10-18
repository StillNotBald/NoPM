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

import { FakeDb, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { generateWeeklyReport, isoWeekdayInZone, loadWeeklySnapshot, parseWeekParam, weekStartOfDay } from "./weekly-report";
import { renderWeeklyReportHtml } from "@/lib/reports/weekly-html";
import { runNudgeStep } from "./step";

// Monday 2026-10-19, 09:00 in Kuala Lumpur (01:00 UTC).
const MONDAY = new Date("2026-10-19T01:00:00.000Z");
const TUESDAY = new Date("2026-10-20T01:00:00.000Z");
// Sunday 2026-10-18 20:00 UTC is already Monday 04:00 in Kuala Lumpur.
const SUNDAY_NIGHT_UTC = new Date("2026-10-18T20:00:00.000Z");

let db: FakeDb;

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pm.example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  db.seed("projects", [{ id: "p1", workspace_id: WS, code: "APO", name: "Apollo", owner_id: ids.manager, rag_status: "red", is_locked: false }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("week helpers", () => {
  it("finds the Monday of a day's ISO week", () => {
    expect(weekStartOfDay("2026-10-19")).toBe("2026-10-19");
    expect(weekStartOfDay("2026-10-25")).toBe("2026-10-19"); // Sunday
    expect(weekStartOfDay("2026-10-21")).toBe("2026-10-19");
  });
  it("reads the weekday in the workspace zone, not UTC", () => {
    expect(isoWeekdayInZone(SUNDAY_NIGHT_UTC, "Asia/Kuala_Lumpur")).toBe(1);
    expect(isoWeekdayInZone(SUNDAY_NIGHT_UTC, "UTC")).toBe(7);
  });
  it("parses a date or an ISO week and rejects anything else", () => {
    expect(parseWeekParam("2026-10-22")).toBe("2026-10-19");
    expect(parseWeekParam("2026-W43")).toBe("2026-10-19");
    expect(parseWeekParam("2026-W01")).toBe("2025-12-29");
    expect(parseWeekParam("2026-02-30")).toBeNull();
    expect(parseWeekParam("2026-W54")).toBeNull();
    expect(parseWeekParam("2026-W53")).toBe("2026-12-28"); // 2026 starts on a Thursday: 53 weeks
    expect(parseWeekParam("2025-W53")).toBeNull(); // 2025 has 52
    expect(parseWeekParam("last week")).toBeNull();
    expect(parseWeekParam("")).toBeNull();
  });
});

describe("scheduled weekly report", () => {
  it("on the configured day stores a snapshot and notifies every admin and manager once", async () => {
    const res = await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" });

    expect(res).toMatchObject({ status: "generated", weekStart: "2026-10-19" });
    const notes = db.rows("notifications").filter((n) => n.type === "report.weekly");
    // seedWorkspace has 1 admin and 3 managers.
    expect(notes.map((n) => n.recipient_id).sort()).toEqual([ids.admin, ids.manager, ids.manager2, ids.requester].sort());
    expect((notes[0].payload as { href: string }).href).toBe("/api/reports/weekly?week=2026-10-19");

    const snap = await loadWeeklySnapshot(WS, "2026-10-19");
    expect(snap?.digest.projects[0]).toMatchObject({ code: "APO", name: "Apollo" });

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ action: "report.weekly.generated", after: { week_start: "2026-10-19", trigger: "scheduled" } });
  });

  it("a second tick the same day sends nothing", async () => {
    await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" });
    const again = await generateWeeklyReport(WS, { now: new Date(MONDAY.getTime() + 3600_000), trigger: "scheduled" });

    expect(again.status).toBe("already_sent");
    expect(db.rows("notifications").filter((n) => n.type === "report.weekly")).toHaveLength(4);
    expect(db.rows("weekly_reports")).toHaveLength(1);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing on any other weekday, and when disabled", async () => {
    db.rows("workspaces").find((w) => w.id === WS)!.weekly_report_day = 2;
    expect((await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" })).status).toBe("not_today");
    db.rows("workspaces").find((w) => w.id === WS)!.weekly_report_day = 1;

    db.rows("workspaces").find((w) => w.id === WS)!.weekly_report_enabled = false;
    expect((await generateWeeklyReport(WS, { now: TUESDAY, trigger: "scheduled" })).status).toBe("disabled");
    expect(db.rows("notifications")).toHaveLength(0);
  });

  it("on the chosen day sends once; a repeat tick the same day adds nothing", async () => {
    expect((await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" })).status).toBe("generated");
    expect((await generateWeeklyReport(WS, { now: new Date(MONDAY.getTime() + 3600_000), trigger: "scheduled" })).status).toBe("already_sent");
    expect(db.rows("notifications").filter((n) => n.type === "report.weekly")).toHaveLength(4);
  });

  it("does not catch up: a missed day stays missed on later days of the week (owner decision D2)", async () => {
    // Monday's tick never ran; Tuesday's must not send it.
    expect((await generateWeeklyReport(WS, { now: TUESDAY, trigger: "scheduled" })).status).toBe("not_today");
    expect(db.rows("notifications")).toHaveLength(0);
    // The manual button is the catch-up.
    expect((await generateWeeklyReport(WS, { now: TUESDAY, trigger: "manual", actor: { type: "user", id: ids.admin, label: "Ada", workspaceId: WS, role: "admin", principalId: ids.admin } as never })).status).toBe("generated");
    // The next chosen day still sends.
    expect((await generateWeeklyReport(WS, { now: new Date("2026-10-26T01:00:00.000Z"), trigger: "scheduled" })).status).toBe("generated");
  });

  it("a manual send earlier the same day does not stop the scheduled one", async () => {
    await generateWeeklyReport(WS, { now: MONDAY, trigger: "manual", actor: { type: "user", id: ids.admin, label: "Ada", workspaceId: WS, role: "admin", principalId: ids.admin } as never });
    expect((await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" })).status).toBe("generated");
  });

  it("frees the day's slot when the audit row cannot be written", async () => {
    writeAuditMock.mockRejectedValueOnce(new Error("audit down"));
    expect((await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" })).status).toBe("failed");
    expect(db.rows("notifications")).toHaveLength(0);
    expect(db.rows("nudge_log")).toHaveLength(0);
    expect((await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" })).status).toBe("generated");
  });
});

describe("manual weekly report", () => {
  const actor = { type: "user", id: ids.admin, label: "Ada Admin", workspaceId: WS, role: "admin", principalId: ids.admin } as never;

  it("works on any day, refreshes the week's snapshot and never takes the scheduled slot", async () => {
    const first = await generateWeeklyReport(WS, { now: TUESDAY, trigger: "manual", actor });
    const second = await generateWeeklyReport(WS, { now: TUESDAY, trigger: "manual", actor });

    expect(first).toMatchObject({ status: "generated", weekStart: "2026-10-19", recipients: 4 });
    expect(second.status).toBe("generated");
    expect(db.rows("weekly_reports")).toHaveLength(1); // refreshed, not duplicated
    expect(db.rows("nudge_log")).toHaveLength(0);
    expect(writeAuditMock).toHaveBeenCalledTimes(2);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ action: "report.weekly.generated", actor: { label: "Ada Admin" }, after: { trigger: "manual" } });

    // Monday's scheduled report still goes out.
    expect((await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" })).status).toBe("generated");
  });
});

describe("daily nudge step", () => {
  it("runs the weekly report for every workspace on its day and survives a quiet workspace", async () => {
    const summary = await runNudgeStep(MONDAY, Date.now() + 60_000);
    expect(summary).toMatchObject({ workspaces: 1, weeklyReports: 1, failed: 0, staleNudged: 0 });
  });
  it("stops starting workspaces at the deadline", async () => {
    const summary = await runNudgeStep(MONDAY, Date.now() - 1);
    expect(summary).toMatchObject({ workspaces: 1, skippedForDeadline: 1, weeklyReports: 0 });
  });
});

describe("renderWeeklyReportHtml", () => {
  it("renders project codes, escapes user text and includes the stale list", async () => {
    await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" });
    const snap = (await loadWeeklySnapshot(WS, "2026-10-19"))!;
    snap.stale = [{ kind: "task", title: "<script>alert(1)</script>", projectCode: "APO", projectName: "Apollo", daysStale: 21 }];
    const html = renderWeeklyReportHtml(snap);

    expect(html).toContain("APO");
    expect(html).toContain("Weekly status report");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain('name="viewport"');
  });
});
