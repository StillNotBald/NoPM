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

import { FakeDb, OTHER_WS, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { daysSince, findStaleItems, isStaleSince, runStaleNudges } from "./stale";
import { resolveNudgeSettings } from "./settings";

const NOW = new Date("2026-10-19T01:00:00.000Z"); // a Monday
const DAY = 24 * 3600_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let db: FakeDb;

function seedWork() {
  db.seed("resource_members", [
    { id: "rm-mo", workspace_id: WS, name: "Mo", profile_id: ids.member },
    { id: "rm-nologin", workspace_id: WS, name: "No Login", profile_id: null },
  ]);
  db.seed("projects", [
    { id: "p1", workspace_id: WS, code: "APO", name: "Apollo", owner_id: ids.manager, rag_status: "green" },
    { id: "p2", workspace_id: WS, code: "DONE", name: "Finished", owner_id: ids.manager, rag_status: "complete" },
    { id: "px", workspace_id: OTHER_WS, code: "FOR", name: "Foreign", owner_id: null, rag_status: "green" },
  ]);
  db.seed("tasks", [
    // stale, assigned
    { id: "t-stale", workspace_id: WS, project_id: "p1", name: "Wire the thing", status_type: "started", assignee_id: "rm-mo", updated_at: ago(20) },
    // fresh
    { id: "t-fresh", workspace_id: WS, project_id: "p1", name: "Fresh", status_type: "started", assignee_id: "rm-mo", updated_at: ago(2) },
    // done: never stale
    { id: "t-done", workspace_id: WS, project_id: "p1", name: "Done", status_type: "completed", assignee_id: "rm-mo", updated_at: ago(90) },
    // in a finished project: not nagged
    { id: "t-old-project", workspace_id: WS, project_id: "p2", name: "Old", status_type: "started", assignee_id: "rm-mo", updated_at: ago(90) },
    // another workspace
    { id: "t-foreign", workspace_id: OTHER_WS, project_id: "px", name: "Foreign", status_type: "started", assignee_id: "rm-mo", updated_at: ago(90) },
  ]);
}

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  db.seed("workspaces", [{ id: OTHER_WS, name: "Other" }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("stale threshold maths", () => {
  it("counts whole days and never goes negative", () => {
    expect(daysSince(ago(3), NOW)).toBe(3);
    expect(daysSince(new Date(NOW.getTime() + DAY).toISOString(), NOW)).toBe(0);
    expect(daysSince("not a date", NOW)).toBe(0);
  });
  it("is stale at exactly the threshold", () => {
    expect(isStaleSince(ago(14), NOW, 14)).toBe(true);
    expect(isStaleSince(ago(13), NOW, 14)).toBe(false);
  });
  it("falls back to the default for missing or invalid settings", () => {
    expect(resolveNudgeSettings(null).stale_days).toBe(14);
    expect(resolveNudgeSettings({ stale_days: 0 }).stale_days).toBe(14);
    expect(resolveNudgeSettings({ stale_days: 400 }).stale_days).toBe(14);
    expect(resolveNudgeSettings({ stale_days: 30, weekly_report_day: 9 })).toMatchObject({ stale_days: 30, weekly_report_day: 1 });
  });
});

describe("findStaleItems", () => {
  it("returns only open, stale, in-workspace items of unfinished projects, with the project code", async () => {
    db.seed("tasks", [{ id: "t-backlog", workspace_id: WS, project_id: "p1", name: "Backlog item", status_type: "backlog", status: "Backlog", assignee_id: null, updated_at: ago(10) }]);
    seedWork();
    db.seed("risks", [
      { id: "r-stale", workspace_id: WS, project_id: "p1", title: "Vendor slips", status: "open", owner_id: null, updated_at: ago(30) },
      { id: "r-closed", workspace_id: WS, project_id: "p1", title: "Closed", status: "closed", owner_id: null, updated_at: ago(30) },
    ]);
    db.seed("issues", [{ id: "i-stale", workspace_id: WS, project_id: "p1", title: "Build red", status: "in_progress", owner_id: ids.admin, updated_at: ago(15) }]);

    const items = await findStaleItems(db, WS, 14, NOW);
    expect(items.map((i) => i.id)).toEqual(["r-stale", "t-stale", "i-stale"]); // stalest first; the 10-day backlog item is under the threshold
    expect(items.every((i) => i.projectCode === "APO")).toBe(true);
    // A risk with no owner falls back to the project owner; a task goes to its assignee.
    expect(items.find((i) => i.id === "r-stale")!.recipientId).toBe(ids.manager);
    expect(items.find((i) => i.id === "t-stale")!.recipientId).toBe(ids.member);
  });

  it("a task goes to the login behind its resource member; a member with no login gets nobody", async () => {
    seedWork();
    db.seed("tasks", [
      { id: "t-nologin", workspace_id: WS, project_id: "p1", name: "Contractor task", status_type: "started", assignee_id: "rm-nologin", updated_at: ago(40) },
    ]);
    const items = await findStaleItems(db, WS, 14, NOW);
    expect(items.find((i) => i.id === "t-stale")!.recipientId).toBe(ids.member);
    expect(items.find((i) => i.id === "t-nologin")!.recipientId).toBeNull();
  });

  it("uses the shared open definition: a backlog task is open, a done or withdrawn item is not", async () => {
    seedWork();
    db.seed("tasks", [
      { id: "t-backlog-old", workspace_id: WS, project_id: "p1", name: "Backlog", status_type: "backlog", status: "Backlog", assignee_id: null, updated_at: ago(60) },
      { id: "t-withdrawn", workspace_id: WS, project_id: "p1", name: "Gone", status_type: "started", status: "Withdrawn", assignee_id: null, updated_at: ago(60) },
    ]);
    db.seed("risks", [{ id: "r-accepted", workspace_id: WS, project_id: "p1", title: "Accepted", status: "accepted", owner_id: null, updated_at: ago(60) }]);
    const ids2 = (await findStaleItems(db, WS, 14, NOW)).map((i) => i.id);
    expect(ids2).toContain("t-backlog-old");
    expect(ids2).toContain("r-accepted");
    expect(ids2).not.toContain("t-withdrawn");
  });

  it("an item with a recent audited change is not stale even if updated_at is old", async () => {
    seedWork();
    db.seed("audit_log", [{ id: "a1", workspace_id: WS, target_type: "task", target_id: "t-stale", action: "task.update", created_at: ago(3) }]);
    expect((await findStaleItems(db, WS, 14, NOW)).map((i) => i.id)).not.toContain("t-stale");
  });

  it("reads each list once and looks projects up in one batch (no per-item queries)", async () => {
    seedWork();
    await findStaleItems(db, WS, 14, NOW);
    const count = (t: string) => db.log.filter((l) => l.table === t).length;
    expect([count("tasks"), count("risks"), count("issues"), count("projects"), count("resource_members")]).toEqual([1, 1, 1, 1, 1]);
  });
});

describe("runStaleNudges", () => {
  it("a stale item produces one notification, one ledger row and one batch audit row", async () => {
    seedWork();
    const res = await runStaleNudges(WS, NOW);

    expect(res).toMatchObject({ status: "sent", sent: 1 });
    const notes = db.rows("notifications");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ recipient_id: ids.member, type: "item.stale", workspace_id: WS });
    expect(String(notes[0].title)).toContain("Wire the thing");
    expect((notes[0].payload as { href: string }).href).toBe("/projects/p1?task=t-stale");

    expect(db.rows("nudge_log")).toHaveLength(1);
    expect(db.rows("nudge_log")[0]).toMatchObject({ target_id: "t-stale", kind: "stale", recipient_id: ids.member, sent_on: "2026-10-19" });

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({
      action: "nudge.sent",
      workspaceId: WS,
      after: { kind: "stale", count: 1, ids: ["t-stale"] },
    });
  });

  it("a second run on the same day produces nothing", async () => {
    seedWork();
    await runStaleNudges(WS, NOW);
    const again = await runStaleNudges(WS, new Date(NOW.getTime() + 3 * 3600_000));

    expect(again.status).toBe("nothing_stale");
    expect(db.rows("notifications")).toHaveLength(1);
    expect(db.rows("nudge_log")).toHaveLength(1);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
  });

  it("does not nag again inside the cooldown, but does after it", async () => {
    seedWork();
    await runStaleNudges(WS, NOW);
    expect((await runStaleNudges(WS, new Date(NOW.getTime() + 3 * DAY))).status).toBe("nothing_stale");
    expect((await runStaleNudges(WS, new Date(NOW.getTime() + 7 * DAY))).status).toBe("sent");
    expect(db.rows("notifications")).toHaveLength(2);
  });

  it("does nothing when nudges are switched off", async () => {
    seedWork();
    db.rows("workspaces").find((w) => w.id === WS)!.nudges_enabled = false;
    const res = await runStaleNudges(WS, NOW);

    expect(res.status).toBe("disabled");
    expect(db.rows("notifications")).toHaveLength(0);
    expect(db.rows("nudge_log")).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("follows the workspace threshold", async () => {
    seedWork();
    db.rows("workspaces").find((w) => w.id === WS)!.stale_days = 30;
    expect((await runStaleNudges(WS, NOW)).status).toBe("nothing_stale"); // 20 days < 30
    db.rows("workspaces").find((w) => w.id === WS)!.stale_days = 7;
    expect((await runStaleNudges(WS, NOW)).status).toBe("sent");
  });

  it("never notifies someone outside the workspace", async () => {
    seedWork();
    db.rows("tasks").find((t) => t.id === "t-stale")!.assignee_id = "11111111-1111-4111-8111-111111111111";
    db.rows("projects").find((p) => p.id === "p1")!.owner_id = null;
    const res = await runStaleNudges(WS, NOW);

    expect(res).toMatchObject({ status: "nothing_stale" }); // nobody to tell: no recipient, no row
    expect(db.rows("notifications")).toHaveLength(0);
  });

  it("writes the audit row after sending, with the count that really went out", async () => {
    seedWork();
    const order: string[] = [];
    writeAuditMock.mockImplementation(async () => {
      order.push(`audit:${db.rows("notifications").length}`);
    });
    await runStaleNudges(WS, NOW);
    expect(order).toEqual(["audit:1"]); // the notification already existed when the audit row was written
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ after: { count: 1, ids: ["t-stale"] } });
  });

  it("writes no audit row and frees the claim when nothing could be delivered", async () => {
    seedWork();
    db.failNext({ table: "notifications", op: "insert", error: { message: "down" } });
    const res = await runStaleNudges(WS, NOW);

    expect(res.status).toBe("failed");
    expect(writeAuditMock).not.toHaveBeenCalled();
    expect(db.rows("nudge_log")).toHaveLength(0);
    expect((await runStaleNudges(WS, NOW)).status).toBe("sent"); // the next tick retries cleanly
  });

  it("lets a racing tick lose on the unique ledger index without a second notification", async () => {
    seedWork();
    db.seed("nudge_log", [
      { workspace_id: WS, kind: "stale", target_type: "task", target_id: "t-stale", recipient_id: ids.member, sent_on: "2026-10-19" },
    ]);
    // The ledger already holds today's row for this item (another tick got there first).
    const res = await runStaleNudges(WS, NOW);
    expect(res.status).toBe("nothing_stale");
    expect(db.rows("notifications")).toHaveLength(0);
  });
});
