import { describe, it, expect } from "vitest";
import { deriveBurndown, type AuditRowForBurndown, type SprintForBurndown } from "./burndown";

function auditRow(
  targetId: string,
  before: string | null,
  after: string | null,
  createdAt: string,
): AuditRowForBurndown {
  return {
    target_id: targetId,
    before: before === null ? null : { status_type: before },
    after: after === null ? null : { status_type: after },
    created_at: createdAt,
  };
}

// Mon 2026-08-03 -> Fri 2026-08-07: a 5-working-day sprint window (Sat/Sun excluded).
const BASE_SPRINT: SprintForBurndown = {
  started_at: "2026-08-03T09:00:00.000Z",
  end_date: "2026-08-07",
  committed_points: 10,
  committed_snapshot: { t1: 6, t2: 4 },
};

describe("deriveBurndown — no start", () => {
  it("returns an empty series when the sprint never started", () => {
    const sprint: SprintForBurndown = { ...BASE_SPRINT, started_at: null };
    expect(deriveBurndown(sprint, [], [], new Date("2026-08-05"))).toEqual({ points: [] });
  });
});

describe("deriveBurndown — zero-transition sprint", () => {
  it("renders a flat remaining line at committed_points, no error", () => {
    const today = new Date("2026-08-05T12:00:00.000Z");
    const series = deriveBurndown(BASE_SPRINT, [], [], today);
    expect(series.points.length).toBeGreaterThan(0);
    for (const p of series.points) {
      expect(p.remaining).toBe(10);
    }
  });

  it("bounds the series at min(today, end_date)", () => {
    const today = new Date("2026-08-05T12:00:00.000Z");
    const series = deriveBurndown(BASE_SPRINT, [], [], today);
    expect(series.points[0].date).toBe("2026-08-03");
    expect(series.points[series.points.length - 1].date).toBe("2026-08-05");
  });

  it("clamps to end_date once the sprint window has fully elapsed", () => {
    const today = new Date("2026-09-01T00:00:00.000Z");
    const series = deriveBurndown(BASE_SPRINT, [], [], today);
    expect(series.points[series.points.length - 1].date).toBe("2026-08-07");
  });
});

describe("deriveBurndown — completion burns points down", () => {
  it("subtracts a task's committed points on-or-after its completion day", () => {
    const rows = [auditRow("t1", "started", "completed", "2026-08-04T18:00:00.000Z")];
    const today = new Date("2026-08-05T12:00:00.000Z");
    const series = deriveBurndown(BASE_SPRINT, [], rows, today);

    const byDate = new Map(series.points.map((p) => [p.date, p.remaining]));
    expect(byDate.get("2026-08-03")).toBe(10); // before completion
    expect(byDate.get("2026-08-04")).toBe(4); // completed same day (t1's 6 points gone)
    expect(byDate.get("2026-08-05")).toBe(4); // stays down
  });

  it("a later un-complete transition re-adds the points on subsequent days", () => {
    const rows = [
      auditRow("t1", "started", "completed", "2026-08-04T09:00:00.000Z"),
      auditRow("t1", "completed", "started", "2026-08-06T09:00:00.000Z"), // reopened
    ];
    const today = new Date("2026-08-07T12:00:00.000Z");
    const series = deriveBurndown(BASE_SPRINT, [], rows, today);
    const byDate = new Map(series.points.map((p) => [p.date, p.remaining]));

    expect(byDate.get("2026-08-04")).toBe(4); // completed
    expect(byDate.get("2026-08-05")).toBe(4); // still complete
    expect(byDate.get("2026-08-06")).toBe(10); // reopened -> re-added
  });

  it("uses the LATEST transition at-or-before the day, ignoring non-status-type edits", () => {
    const rows = [
      auditRow("t1", "started", "started", "2026-08-04T08:00:00.000Z"), // rename, not a move
      auditRow("t1", "started", "completed", "2026-08-04T20:00:00.000Z"),
    ];
    const series = deriveBurndown(BASE_SPRINT, [], rows, new Date("2026-08-04T23:00:00.000Z"));
    const last = series.points[series.points.length - 1];
    expect(last.remaining).toBe(4);
  });

  it("never counts a transition for a task NOT in the committed snapshot", () => {
    const rows = [auditRow("t99", "started", "completed", "2026-08-04T09:00:00.000Z")];
    const series = deriveBurndown(BASE_SPRINT, [], rows, new Date("2026-08-05"));
    expect(series.points.every((p) => p.remaining === 10)).toBe(true);
  });

  it("clamps remaining at 0 rather than going negative", () => {
    const rows = [
      auditRow("t1", "started", "completed", "2026-08-03T09:00:00.000Z"),
      auditRow("t2", "started", "completed", "2026-08-03T10:00:00.000Z"),
    ];
    const series = deriveBurndown(BASE_SPRINT, [], rows, new Date("2026-08-03T23:00:00.000Z"));
    expect(series.points[0].remaining).toBe(0);
  });
});

describe("deriveBurndown — ideal line", () => {
  it("starts below committed on day 1 (linear across the 5 working days) and never goes negative", () => {
    const series = deriveBurndown(BASE_SPRINT, [], [], new Date("2026-08-07T12:00:00.000Z"));
    const first = series.points[0];
    const last = series.points[series.points.length - 1];
    expect(first.date).toBe("2026-08-03");
    expect(first.ideal).toBe(8); // 10 * (1 - 1/5)
    expect(last.date).toBe("2026-08-07");
    expect(last.ideal).toBe(0); // 10 * (1 - 5/5)
  });

  it("is monotonically non-increasing across the window", () => {
    const series = deriveBurndown(BASE_SPRINT, [], [], new Date("2026-08-07T12:00:00.000Z"));
    for (let i = 1; i < series.points.length; i++) {
      expect(series.points[i].ideal).toBeLessThanOrEqual(series.points[i - 1].ideal);
    }
  });
});

describe("deriveBurndown — missing committed_snapshot fallback", () => {
  it("derives the committed set from attachedTasks' story_points when committed_snapshot is absent", () => {
    const sprint: SprintForBurndown = {
      started_at: "2026-08-03T09:00:00.000Z",
      end_date: "2026-08-07",
      committed_points: null,
      committed_snapshot: null,
    };
    const attached = [
      { id: "t1", story_points: 3 },
      { id: "t2", story_points: 2 },
    ];
    const series = deriveBurndown(sprint, attached, [], new Date("2026-08-03T23:00:00.000Z"));
    expect(series.points[0].remaining).toBe(5);
  });
});
