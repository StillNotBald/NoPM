import { describe, it, expect } from "vitest";
import { deriveFlow, timeInStatus, type AuditRowForFlow, type TaskForFlow } from "./flow";

function task(id: string, projectId: string, createdAt: string, sprintId?: string | null): TaskForFlow {
  return { id, project_id: projectId, sprint_id: sprintId, created_at: createdAt };
}

function row(
  targetId: string,
  action: "task.create" | "task.update",
  before: string | null,
  after: string | null,
  createdAt: string,
): AuditRowForFlow {
  return {
    target_id: targetId,
    action,
    before: before === null ? null : { status_type: before },
    after: after === null ? null : { status_type: after },
    created_at: createdAt,
  };
}

describe("deriveFlow — skip-started", () => {
  it("excludes a task from cycle time when it never enters 'started', but still computes lead time", () => {
    const tasks = [task("t1", "p1", "2026-08-01T00:00:00.000Z")];
    const transitions = new Map([
      [
        "t1",
        [
          row("t1", "task.create", null, "backlog", "2026-08-01T00:00:00.000Z"),
          row("t1", "task.update", "backlog", "completed", "2026-08-03T00:00:00.000Z"),
        ],
      ],
    ]);
    const flow = deriveFlow(tasks, transitions);
    const r = flow.tasks[0];
    expect(r.cycleTimeHours).toBeNull();
    expect(r.cycleExcludedReason).toBe("skipped-started");
    expect(r.leadTimeHours).toBe(48);
    expect(r.leadExcludedReason).toBeNull();
  });
});

describe("deriveFlow — direct-start-create", () => {
  it("uses the task.create row as cycle start when the task was created directly in 'started'", () => {
    const tasks = [task("t1", "p1", "2026-08-01T00:00:00.000Z")];
    const transitions = new Map([
      [
        "t1",
        [
          row("t1", "task.create", null, "started", "2026-08-01T00:00:00.000Z"),
          row("t1", "task.update", "started", "completed", "2026-08-02T12:00:00.000Z"),
        ],
      ],
    ]);
    const flow = deriveFlow(tasks, transitions);
    const r = flow.tasks[0];
    expect(r.cycleExcludedReason).toBeNull();
    expect(r.cycleTimeHours).toBe(36);
    expect(r.leadTimeHours).toBe(36);
  });
});

describe("deriveFlow — reopen semantics", () => {
  it("uses the LATEST completion, not the first, for both cycle and lead time", () => {
    const tasks = [task("t1", "p1", "2026-08-01T00:00:00.000Z")];
    const transitions = new Map([
      [
        "t1",
        [
          row("t1", "task.create", null, "backlog", "2026-08-01T00:00:00.000Z"),
          row("t1", "task.update", "backlog", "started", "2026-08-01T06:00:00.000Z"),
          row("t1", "task.update", "started", "completed", "2026-08-02T00:00:00.000Z"), // first completion — 18h cycle
          row("t1", "task.update", "completed", "started", "2026-08-03T00:00:00.000Z"), // reopened
          row("t1", "task.update", "started", "completed", "2026-08-05T00:00:00.000Z"), // final completion
        ],
      ],
    ]);
    const flow = deriveFlow(tasks, transitions);
    const r = flow.tasks[0];
    // Cycle start anchored at the FIRST entry into 'started' (Aug 1 06:00),
    // end anchored at the LAST completion (Aug 5 00:00) — NOT the first
    // completion (Aug 2 00:00, which would be 18h).
    expect(r.cycleTimeHours).toBe(90); // Aug 1 06:00 -> Aug 5 00:00
    expect(r.leadTimeHours).toBe(96); // Aug 1 00:00 -> Aug 5 00:00
  });
});

describe("deriveFlow — zero-transition", () => {
  it("excludes both metrics with reason 'no-transitions' rather than throwing, for a task with no audit rows at all", () => {
    const tasks = [task("t1", "p1", "2026-08-01T00:00:00.000Z")];
    const flow = deriveFlow(tasks, new Map());
    const r = flow.tasks[0];
    expect(r.cycleTimeHours).toBeNull();
    expect(r.cycleExcludedReason).toBe("no-transitions");
    expect(r.leadTimeHours).toBeNull();
    expect(r.leadExcludedReason).toBe("no-transitions");
  });
});

describe("deriveFlow — incomplete task (started but never completed)", () => {
  it("excludes cycle time with reason 'incomplete' (has a start, no end) and lead time likewise", () => {
    const tasks = [task("t1", "p1", "2026-08-01T00:00:00.000Z")];
    const transitions = new Map([
      [
        "t1",
        [
          row("t1", "task.create", null, "backlog", "2026-08-01T00:00:00.000Z"),
          row("t1", "task.update", "backlog", "started", "2026-08-02T00:00:00.000Z"),
        ],
      ],
    ]);
    const flow = deriveFlow(tasks, transitions);
    const r = flow.tasks[0];
    expect(r.cycleExcludedReason).toBe("incomplete");
    expect(r.leadExcludedReason).toBe("incomplete");
  });

  it("ignores non-status task.update rows (rename, reassign) when finding start/completion", () => {
    const tasks = [task("t1", "p1", "2026-08-01T00:00:00.000Z")];
    const transitions = new Map([
      [
        "t1",
        [
          row("t1", "task.create", null, "backlog", "2026-08-01T00:00:00.000Z"),
          row("t1", "task.update", "backlog", "started", "2026-08-02T00:00:00.000Z"),
          row("t1", "task.update", "started", "started", "2026-08-02T06:00:00.000Z"), // rename, not a move
          row("t1", "task.update", "started", "completed", "2026-08-03T00:00:00.000Z"),
        ],
      ],
    ]);
    const flow = deriveFlow(tasks, transitions);
    const r = flow.tasks[0];
    expect(r.cycleTimeHours).toBe(24); // Aug 2 00:00 -> Aug 3 00:00, unaffected by the rename row
  });
});

describe("deriveFlow — aggregation (median/p85, grouping, exclusion counts)", () => {
  it("computes median/p85 over cycle & lead hours per project, counts exclusions, and groups by sprint", () => {
    const created = "2026-08-01T00:00:00.000Z";
    const tasks = [
      task("t1", "p1", created, "s1"),
      task("t2", "p1", created, "s1"),
      task("t3", "p1", created, "s1"),
      task("t4", "p1", created, null), // not attached to a sprint
    ];

    function completedTask(id: string, cycleHours: number): [string, AuditRowForFlow[]] {
      const startAt = "2026-08-01T00:00:00.000Z";
      const endAt = new Date(new Date(startAt).getTime() + cycleHours * 60 * 60 * 1000).toISOString();
      return [
        id,
        [
          row(id, "task.create", null, "started", startAt),
          row(id, "task.update", "started", "completed", endAt),
        ],
      ];
    }

    const transitions = new Map<string, AuditRowForFlow[]>([
      completedTask("t1", 10),
      completedTask("t2", 20),
      completedTask("t3", 30),
      completedTask("t4", 40),
    ]);

    const flow = deriveFlow(tasks, transitions);

    const byProject = flow.byProject.get("p1")!;
    expect(byProject.sampleSize).toBe(4);
    expect(byProject.cycleTimeHoursMedian).toBe(25); // median of 10,20,30,40 -> (20+30)/2
    expect(byProject.cycleTimeHoursP85).toBe(40); // nearest-rank 85th of 4 values -> ceil(0.85*4)=4th value
    expect(byProject.cycleExcludedCount).toBe(0);
    expect(byProject.leadExcludedCount).toBe(0);

    const bySprint = flow.bySprint.get("s1")!;
    expect(bySprint.sampleSize).toBe(3); // t4 excluded — no sprint_id
    expect(bySprint.cycleTimeHoursMedian).toBe(20); // median of 10,20,30

    expect(flow.bySprint.has("s4-nonexistent")).toBe(false);
  });

  it("excludes null values from median/p85 but still counts them in sampleSize + excluded counts", () => {
    const tasks = [task("t1", "p1", "2026-08-01T00:00:00.000Z"), task("t2", "p1", "2026-08-01T00:00:00.000Z")];
    const transitions = new Map<string, AuditRowForFlow[]>([
      [
        "t1",
        [
          row("t1", "task.create", null, "started", "2026-08-01T00:00:00.000Z"),
          row("t1", "task.update", "started", "completed", "2026-08-02T00:00:00.000Z"),
        ],
      ],
      // t2 has no transitions at all -> excluded from both
    ]);
    const agg = deriveFlow(tasks, transitions).byProject.get("p1")!;
    expect(agg.sampleSize).toBe(2);
    expect(agg.cycleTimeHoursMedian).toBe(24);
    expect(agg.cycleExcludedCount).toBe(1);
    expect(agg.leadExcludedCount).toBe(1);
  });
});

describe("timeInStatus", () => {
  const NOW = new Date("2026-08-05T00:00:00.000Z");

  it("returns an empty array for a task with no transitions (zero-transition, never throws)", () => {
    expect(timeInStatus([], NOW)).toEqual([]);
  });

  it("derives closed spans between consecutive real transitions, and leaves the final span open against `now`", () => {
    const transitions = [
      row("t1", "task.create", null, "backlog", "2026-08-01T00:00:00.000Z"),
      row("t1", "task.update", "backlog", "started", "2026-08-02T00:00:00.000Z"),
      row("t1", "task.update", "started", "completed", "2026-08-03T00:00:00.000Z"),
    ];
    const spans = timeInStatus(transitions, NOW);
    expect(spans).toEqual([
      { status_type: "backlog", entered_at: "2026-08-01T00:00:00.000Z", exited_at: "2026-08-02T00:00:00.000Z", hours: 24 },
      { status_type: "started", entered_at: "2026-08-02T00:00:00.000Z", exited_at: "2026-08-03T00:00:00.000Z", hours: 24 },
      { status_type: "completed", entered_at: "2026-08-03T00:00:00.000Z", exited_at: null, hours: 48 },
    ]);
  });

  it("skips non-status task.update rows (rename) without creating a spurious span", () => {
    const transitions = [
      row("t1", "task.create", null, "backlog", "2026-08-01T00:00:00.000Z"),
      row("t1", "task.update", "backlog", "backlog", "2026-08-01T12:00:00.000Z"), // rename, same status
      row("t1", "task.update", "backlog", "started", "2026-08-02T00:00:00.000Z"),
    ];
    const spans = timeInStatus(transitions, NOW);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({
      status_type: "backlog",
      entered_at: "2026-08-01T00:00:00.000Z",
      exited_at: "2026-08-02T00:00:00.000Z",
      hours: 24,
    });
  });

  it("tolerates out-of-order input by sorting defensively", () => {
    const transitions = [
      row("t1", "task.update", "backlog", "started", "2026-08-02T00:00:00.000Z"),
      row("t1", "task.create", null, "backlog", "2026-08-01T00:00:00.000Z"),
    ];
    const spans = timeInStatus(transitions, NOW);
    expect(spans[0].status_type).toBe("backlog");
    expect(spans[1].status_type).toBe("started");
  });
});
