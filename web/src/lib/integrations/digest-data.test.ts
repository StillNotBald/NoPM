import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));

import { gatherDigestData } from "./digest-data";
import { FakeDb, OTHER_WS, WS } from "./test-support";

const NOW = new Date("2026-10-16T01:00:00.000Z");

let db: FakeDb;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pm.example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = new FakeDb();
  state.db = db;
  db.seed("workspaces", [
    { id: WS, name: "Acme PMO" },
    { id: OTHER_WS, name: "Other Org" },
  ]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("gatherDigestData", () => {
  it("is workspace-filtered on every section", async () => {
    db.seed("projects", [
      { id: "p1", workspace_id: WS, name: "Apollo", rag_status: "green", is_locked: false },
      { id: "px", workspace_id: OTHER_WS, name: "Foreign Project", rag_status: "red", is_locked: false },
    ]);
    db.seed("milestones", [
      { id: "m1", workspace_id: WS, project_id: "p1", name: "Beta", target_date: "2026-10-20", status: "on_track" },
      { id: "mx", workspace_id: OTHER_WS, project_id: "px", name: "Foreign milestone", target_date: "2026-10-20", status: "on_track" },
    ]);
    db.seed("risks", [
      { id: "r1", workspace_id: WS, severity: "high", status: "open" },
      { id: "rx", workspace_id: OTHER_WS, severity: "critical", status: "open" },
    ]);
    db.seed("deletion_requests", [{ id: "d1", workspace_id: WS, status: "pending" }, { id: "dx", workspace_id: OTHER_WS, status: "pending" }]);
    db.seed("change_requests", [{ id: "c1", workspace_id: WS, status: "raised" }, { id: "cx", workspace_id: OTHER_WS, status: "raised" }]);

    const data = await gatherDigestData(WS, { now: NOW });

    expect(data.workspaceName).toBe("Acme PMO");
    expect(data.appUrl).toBe("https://pm.example.test");
    expect(data.generatedAt).toBe(NOW.toISOString());
    expect(data.projects.map((p) => p.name)).toEqual(["Apollo"]);
    expect(data.milestonesDueSoon.map((m) => m.name)).toEqual(["Beta"]);
    expect(data.openHighRisks).toBe(1);
    expect(data.pendingApprovals).toBe(2); // 1 deletion + 1 change request, none from the other workspace
    expect(JSON.stringify(data)).not.toMatch(/Foreign|Other Org/);
  });

  it("puts projects needing attention first, caps the list, and maps status", async () => {
    db.seed(
      "projects",
      [
        { id: "a", workspace_id: WS, name: "A-done", rag_status: "complete", is_locked: false },
        { id: "b", workspace_id: WS, name: "B-green", rag_status: "green", is_locked: true },
        { id: "c", workspace_id: WS, name: "C-red", rag_status: "red", is_locked: false },
        { id: "d", workspace_id: WS, name: "D-amber", rag_status: "amber", is_locked: false },
      ],
    );
    const data = await gatherDigestData(WS, { now: NOW });
    expect(data.projects.map((p) => p.name)).toEqual(["C-red", "D-amber", "B-green", "A-done"]);
    expect(data.projects.find((p) => p.name === "B-green")?.status).toBe("locked");
    expect(data.projects.find((p) => p.name === "A-done")?.status).toBe("complete");
    expect(data.projects.find((p) => p.name === "C-red")).toMatchObject({ id: "c", health: "red", status: "active" });

    db.seed(
      "projects",
      Array.from({ length: 40 }, (_, i) => ({ id: `bulk${i}`, workspace_id: WS, name: `Bulk ${i}`, rag_status: "green", is_locked: false })),
    );
    expect((await gatherDigestData(WS, { now: NOW })).projects).toHaveLength(25);
  });

  it("lists milestones due in the next 14 days, soonest first, excluding past, far-future and completed ones", async () => {
    db.seed("projects", [{ id: "p1", workspace_id: WS, name: "Apollo", rag_status: "green", is_locked: false }]);
    db.seed("milestones", [
      { id: "m-past", workspace_id: WS, project_id: "p1", name: "Past", target_date: "2026-10-15", status: "delayed" },
      { id: "m-today", workspace_id: WS, project_id: "p1", name: "Today", target_date: "2026-10-16", status: "on_track" },
      { id: "m-edge", workspace_id: WS, project_id: "p1", name: "Edge", target_date: "2026-10-30", status: "at_risk" },
      { id: "m-far", workspace_id: WS, project_id: "p1", name: "Far", target_date: "2026-10-31", status: "on_track" },
      { id: "m-done", workspace_id: WS, project_id: "p1", name: "Done", target_date: "2026-10-20", status: "completed" },
      { id: "m-soon", workspace_id: WS, project_id: "p1", name: "Soon", target_date: "2026-10-18", status: "not_started" },
    ]);
    const data = await gatherDigestData(WS, { now: NOW });
    expect(data.milestonesDueSoon.map((m) => m.name)).toEqual(["Today", "Soon", "Edge"]);
    expect(data.milestonesDueSoon[0]).toEqual({ id: "m-today", name: "Today", projectName: "Apollo", dueDate: "2026-10-16" });
  });

  it("counts only open high/critical risks", async () => {
    db.seed("risks", [
      { id: "1", workspace_id: WS, severity: "high", status: "open" },
      { id: "2", workspace_id: WS, severity: "critical", status: "mitigating" },
      { id: "3", workspace_id: WS, severity: "high", status: "closed" },
      { id: "4", workspace_id: WS, severity: "medium", status: "open" },
      { id: "5", workspace_id: WS, severity: "critical", status: "accepted" },
    ]);
    expect((await gatherDigestData(WS, { now: NOW })).openHighRisks).toBe(2);
  });

  it("sums every kind of pending approval", async () => {
    db.seed("deletion_requests", [{ id: "1", workspace_id: WS, status: "pending" }, { id: "2", workspace_id: WS, status: "committed" }]);
    db.seed("change_requests", [{ id: "1", workspace_id: WS, status: "under_review" }, { id: "2", workspace_id: WS, status: "approved" }]);
    db.seed("rebaselines", [{ id: "1", workspace_id: WS, status: "pending_approval" }, { id: "2", workspace_id: WS, status: "applied" }]);
    expect((await gatherDigestData(WS, { now: NOW })).pendingApprovals).toBe(3);
  });

  it("degrades a failing section to empty/zero instead of failing the whole digest", async () => {
    db.seed("projects", [{ id: "p1", workspace_id: WS, name: "Apollo", rag_status: "green", is_locked: false }]);
    db.failNext({ table: "risks", op: "select", error: { message: "table missing" } });
    db.failNext({ table: "milestones", op: "select", error: { message: "boom" } });

    const data = await gatherDigestData(WS, { now: NOW });

    expect(data.openHighRisks).toBe(0);
    expect(data.milestonesDueSoon).toEqual([]);
    expect(data.projects).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("falls back to a generic workspace name when it cannot be read", async () => {
    db.failNext({ table: "workspaces", op: "select", error: { message: "boom" } });
    expect((await gatherDigestData(WS, { now: NOW })).workspaceName).toBe("Workspace");
  });
});
