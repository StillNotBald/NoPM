import { describe, it, expect, beforeEach } from "vitest";
import { FakeDb, OTHER_WS, WS, ids } from "@/lib/integrations/test-support";
import { gatherChangeFeed, groupByDay, isUuid, zonedDayStartUtc, applyFeedFilters, FEED_KINDS } from "./feed";

const TZ = "Asia/Kuala_Lumpur";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const P2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const T1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const R1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const CR1 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const GONE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const TOKEN = "ffffffff-ffff-4fff-8fff-fffffffffff1";

let db: FakeDb;
let n = 0;
const audit = (over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  workspace_id: WS,
  actor_type: "user",
  actor_id: ids.member,
  actor_label: "Mo Member",
  principal_id: ids.member,
  action: "task.update",
  target_type: "task",
  target_id: T1,
  before: null,
  after: { project_id: P1 },
  created_at: "2026-10-19T02:00:00.000Z",
  ...over,
});

beforeEach(() => {
  n = 0;
  db = new FakeDb();
  db.seed("projects", [
    { id: P1, workspace_id: WS, code: "APO", name: "Apollo" },
    { id: P2, workspace_id: WS, code: "ZEN", name: "Zenith" },
  ]);
  db.seed("profiles", [
    { id: ids.member, workspace_id: WS, display_name: "Mo Member", email: "mo@example.test" },
    { id: ids.admin, workspace_id: WS, display_name: "Ada Admin", email: "ada@example.test" },
  ]);
  db.seed("tasks", [{ id: T1, workspace_id: WS, project_id: P1, name: "Wire the thing" }]);
  db.seed("risks", [{ id: R1, workspace_id: WS, project_id: P2, title: "Vendor slips" }]);
  db.seed("change_requests", [{ id: CR1, workspace_id: WS, project_id: P1, title: "Add a gate" }]);
  db.seed("audit_log", [
    audit({}),
    audit({ target_type: "risk", target_id: R1, action: "risk.create", after: { project_id: P2, title: "Vendor slips" }, created_at: "2026-10-19T03:00:00.000Z" }),
    audit({ target_type: "change_request", target_id: CR1, action: "change_request.create", created_at: "2026-10-18T03:00:00.000Z" }),
    audit({ target_type: "project", target_id: P2, action: "project.update", after: { name: "Zenith" }, created_at: "2026-10-17T03:00:00.000Z" }),
    // A task that was deleted since: title comes from the audited row, nothing to link to.
    audit({ target_type: "task", target_id: GONE, action: "task.delete", before: { name: "Old task", project_id: P1 }, after: null, created_at: "2026-10-16T03:00:00.000Z" }),
    // Done through a token that belongs to Ada.
    audit({ actor_type: "token", actor_id: TOKEN, actor_label: "agent-token", principal_id: ids.admin, action: "task.update", created_at: "2026-10-15T03:00:00.000Z" }),
    // Not a feed kind, and another workspace.
    audit({ target_type: "workspace", target_id: WS, action: "nudge.sent", target_title: undefined }),
    audit({ workspace_id: OTHER_WS, target_type: "task", target_id: "ffffffff-ffff-4fff-8fff-fffffffffff9", action: "task.create" }),
  ]);
});

describe("gatherChangeFeed", () => {
  it("lists feed kinds in this workspace only, newest first, with project code, actor, action and title", async () => {
    const feed = await gatherChangeFeed(db, WS, {}, { timeZone: TZ });

    expect(feed.error).toBeNull();
    expect(feed.total).toBe(6);
    expect(feed.rows.map((r) => r.action)).toEqual([
      "risk.create",
      "task.update",
      "change_request.create",
      "project.update",
      "task.delete",
      "task.update",
    ]);
    const first = feed.rows[0];
    expect(first).toMatchObject({ projectCode: "ZEN", actorLabel: "Mo Member", targetTitle: "Vendor slips", kind: "risk", href: `/risks?risk=${R1}` });
    expect(feed.rows[1]).toMatchObject({ projectCode: "APO", targetTitle: "Wire the thing", href: `/projects/${P1}?task=${T1}` });
    expect(feed.rows[3]).toMatchObject({ kind: "project", projectCode: "ZEN", targetTitle: "Zenith", href: `/projects/${P2}` });
  });

  it("falls back to the audited snapshot for a record that no longer exists, with no link", async () => {
    const feed = await gatherChangeFeed(db, WS, {}, { timeZone: TZ });
    const gone = feed.rows.find((r) => r.action === "task.delete")!;
    expect(gone).toMatchObject({ targetTitle: "Old task", projectCode: "APO", href: null });
  });

  it("shows the human behind a token", async () => {
    const feed = await gatherChangeFeed(db, WS, {}, { timeZone: TZ });
    const viaToken = feed.rows.find((r) => r.actorLabel === "agent-token")!;
    expect(viaToken.onBehalfOf).toBe("Ada Admin");
    expect(feed.rows[0].onBehalfOf).toBeNull();
  });

  it("filters by project (the project itself and records whose audited row names it)", async () => {
    const feed = await gatherChangeFeed(db, WS, { projectId: P2 }, { timeZone: TZ });
    expect(feed.rows.map((r) => r.action)).toEqual(["risk.create", "project.update"]);
  });

  it("finds a project's records even when the audit payload never names the project", async () => {
    db.seed("audit_log", [audit({ target_type: "task", target_id: T1, action: "task.comment", after: { note: "no project_id here" }, created_at: "2026-10-19T04:00:00.000Z" })]);
    const feed = await gatherChangeFeed(db, WS, { projectId: P1 }, { timeZone: TZ });
    expect(feed.rows.map((r) => r.action)).toContain("task.comment");
    expect(feed.rows[0].action).toBe("task.comment");
    expect(new Set(feed.rows.map((r) => r.id)).size).toBe(feed.rows.length); // no duplicates from the two paths
    expect(feed.total).toBe(feed.rows.length);
  });

  it("filters by kind, by person (including their tokens) and by date range", async () => {
    expect((await gatherChangeFeed(db, WS, { kinds: ["risk"] }, { timeZone: TZ })).rows).toHaveLength(1);

    const ada = await gatherChangeFeed(db, WS, { actorId: ids.admin }, { timeZone: TZ });
    expect(ada.rows.map((r) => r.actorLabel)).toEqual(["agent-token"]);

    const range = await gatherChangeFeed(
      db,
      WS,
      { from: zonedDayStartUtc("2026-10-18", TZ).toISOString(), to: zonedDayStartUtc("2026-10-20", TZ).toISOString() },
      { timeZone: TZ },
    );
    expect(range.rows.map((r) => r.action)).toEqual(["risk.create", "task.update", "change_request.create"]);
  });

  it("resolves titles in batched queries, one per record type, never per row", async () => {
    await gatherChangeFeed(db, WS, {}, { timeZone: TZ });
    const count = (t: string) => db.log.filter((l) => l.table === t).length;
    expect([count("audit_log"), count("tasks"), count("risks"), count("change_requests"), count("projects"), count("profiles")]).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("pages", async () => {
    const page2 = await gatherChangeFeed(db, WS, {}, { timeZone: TZ, pageSize: 4, page: 2 });
    expect(page2.rows).toHaveLength(2);
    expect(page2.total).toBe(6);
  });

  it("treats a malformed id filter as matching nothing, not as no filter", async () => {
    expect((await gatherChangeFeed(db, WS, { projectId: "x,or=(1=1)" }, { timeZone: TZ })).rows).toHaveLength(0);
    expect((await gatherChangeFeed(db, WS, { actorId: "not-a-uuid" }, { timeZone: TZ })).rows).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("groups newest-first rows by day, keeping order", async () => {
    const feed = await gatherChangeFeed(db, WS, {}, { timeZone: TZ });
    const groups = groupByDay(feed.rows);
    expect(groups.map((g) => g.day)).toEqual(["2026-10-19", "2026-10-18", "2026-10-17", "2026-10-16", "2026-10-15"]);
    expect(groups[0].rows).toHaveLength(2);
  });
  it("puts a late-evening UTC row on the next workspace day", async () => {
    db.seed("audit_log", [audit({ created_at: "2026-10-19T20:30:00.000Z" })]);
    const feed = await gatherChangeFeed(db, WS, {}, { timeZone: TZ });
    expect(feed.rows[0].day).toBe("2026-10-20"); // 04:30 the next morning in Kuala Lumpur
  });
  it("converts a workspace day to its start instant", () => {
    expect(zonedDayStartUtc("2026-10-19", "Asia/Kuala_Lumpur").toISOString()).toBe("2026-10-18T16:00:00.000Z");
    expect(zonedDayStartUtc("2026-10-19", "UTC").toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });
  it("recognises uuids and exposes the seven kinds", () => {
    expect(isUuid(P1)).toBe(true);
    expect(isUuid("1; drop")).toBe(false);
    expect(FEED_KINDS).toHaveLength(7);
  });
  it("applyFeedFilters is a no-op with no filters", () => {
    const calls: string[] = [];
    const q = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => (calls.push(`${String(k)}${a.length}`), q) });
    applyFeedFilters(q, {});
    expect(calls).toEqual([]);
  });
});
