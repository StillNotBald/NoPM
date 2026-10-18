import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));

import { TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { WeeklyReportFakeDb } from "./weekly-report-test-support";
import { generateWeeklyReport, isoWeekdayInZone, loadWeeklySnapshot, parseWeekParam, weekStartOfDay } from "./weekly-report";
import { renderWeeklyReportHtml } from "@/lib/reports/weekly-html";
import { runNudgeStep } from "./step";

// Monday 2026-10-19, 09:00 in Kuala Lumpur (01:00 UTC).
const MONDAY = new Date("2026-10-19T01:00:00.000Z");
const TUESDAY = new Date("2026-10-20T01:00:00.000Z");
// Sunday 2026-10-18 20:00 UTC is already Monday 04:00 in Kuala Lumpur.
const SUNDAY_NIGHT_UTC = new Date("2026-10-18T20:00:00.000Z");

// The claim, the report and the audit row are ONE database call (nopm_weekly_report_store, R-165);
// the fake mirrors it, so db.audits holds the audit rows that call wrote.
let db: WeeklyReportFakeDb;

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pm.example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = new WeeklyReportFakeDb();
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

    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      action: "report.weekly.generated",
      actor_label: "system:weekly-report",
      actor_id: "00000000-0000-0000-0000-000000000000",
      after: { week_start: "2026-10-19", trigger: "scheduled", recipients: 4 },
    });
    // every scheduled recipient got a ledger row from the same call
    expect(db.rows("nudge_log")).toHaveLength(4);
  });

  it("a second tick the same day sends nothing", async () => {
    await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" });
    const again = await generateWeeklyReport(WS, { now: new Date(MONDAY.getTime() + 3600_000), trigger: "scheduled" });

    expect(again.status).toBe("already_sent");
    expect(db.rows("notifications").filter((n) => n.type === "report.weekly")).toHaveLength(4);
    expect(db.rows("weekly_reports")).toHaveLength(1);
    expect(db.audits).toHaveLength(1); // the replay wrote no second audit row
  });

  it("a replayed run changes nothing: no second report write, claim or audit row", async () => {
    await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" });
    const snapshot = () => JSON.stringify({ r: db.rows("weekly_reports"), n: db.rows("nudge_log"), a: db.audits, m: db.rows("notifications") });
    const before = snapshot();
    const callsBefore = db.weeklyCalls.length;
    const again = await generateWeeklyReport(WS, { now: new Date(MONDAY.getTime() + 60_000), trigger: "scheduled" });
    expect(again.status).toBe("already_sent");
    expect(db.weeklyCalls.length).toBe(callsBefore); // the early read short-circuits before the snapshot is even built
    expect(snapshot()).toBe(before);
  });

  it("a lost claim race returns already_sent and writes nothing", async () => {
    db.loseClaim = true;
    const res = await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" });
    expect(res.status).toBe("already_sent");
    expect(db.weeklyCalls).toHaveLength(1);
    expect(db.rows("weekly_reports")).toHaveLength(0);
    expect(db.rows("nudge_log")).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
    expect(db.rows("notifications")).toHaveLength(0);
  });

  it("builds the snapshot first and sends the claim, the snapshot and the audit object in ONE call", async () => {
    await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" });
    expect(db.weeklyCalls).toHaveLength(1);
    const call = db.weeklyCalls[0];
    expect(call).toMatchObject({ p_workspace_id: WS, p_week_start: "2026-10-19", p_sent_on: "2026-10-19", p_trigger: "scheduled", p_generated_by: "system:weekly-report" });
    expect((call.p_snapshot as { weekStart: string }).weekStart).toBe("2026-10-19");
    expect((call.p_recipients as string[]).length).toBe(4);
    expect(call.p_audit).toMatchObject({ action: "report.weekly.generated", target_type: "workspace", actor_type: "token", actor_label: "system:weekly-report", principal_id: null });
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

  it("leaves no claim, report or audit row when the audit write fails, so the next tick retries", async () => {
    db.failAudit = true;
    expect((await generateWeeklyReport(WS, { now: MONDAY, trigger: "scheduled" })).status).toBe("failed");
    expect(db.rows("notifications")).toHaveLength(0);
    expect(db.rows("nudge_log")).toHaveLength(0);
    expect(db.rows("weekly_reports")).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
    db.failAudit = false;
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
    expect(db.audits).toHaveLength(2);
    expect(db.audits[0]).toMatchObject({ action: "report.weekly.generated", actor_label: "Ada Admin", actor_type: "user", after: { trigger: "manual" } });
    expect(db.weeklyCalls.every((c) => c.p_trigger === "manual")).toBe(true);

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
