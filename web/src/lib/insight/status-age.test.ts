import { describe, it, expect } from "vitest";
import { deriveStatusAges, STALE_STATUS_AGE_DAYS, type AuditRowForStatusAge, type TaskForStatusAge } from "./status-age";

const NOW = new Date("2026-08-15T12:00:00.000Z");

function task(id: string, createdAt: string): TaskForStatusAge {
  return { id, created_at: createdAt };
}

function auditRow(
  targetId: string,
  before: string | null,
  after: string | null,
  createdAt: string,
): AuditRowForStatusAge {
  return {
    target_id: targetId,
    before: before === null ? null : { status_type: before },
    after: after === null ? null : { status_type: after },
    created_at: createdAt,
  };
}

describe("deriveStatusAges — never-transitioned tasks", () => {
  it("falls back to created_at, labelled 'created', when there are no audit rows at all", () => {
    const tasks = [task("t1", "2026-08-01T00:00:00.000Z")];
    const ages = deriveStatusAges(tasks, [], NOW);
    expect(ages.get("t1")).toEqual({
      days: 14,
      since: "created",
      changedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("ignores audit rows for OTHER tasks", () => {
    const tasks = [task("t1", "2026-08-01T00:00:00.000Z")];
    const rows = [auditRow("t2", "backlog", "started", "2026-08-10T00:00:00.000Z")];
    expect(deriveStatusAges(tasks, rows, NOW).get("t1")!.since).toBe("created");
  });

  it("ignores task.update rows that don't touch status_type (e.g. a rename)", () => {
    const tasks = [task("t1", "2026-08-01T00:00:00.000Z")];
    const rows = [auditRow("t1", "started", "started", "2026-08-10T00:00:00.000Z")];
    const age = deriveStatusAges(tasks, rows, NOW).get("t1")!;
    expect(age.since).toBe("created");
    expect(age.changedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("ignores rows missing status_type on either side (defensive against odd audit shapes)", () => {
    const tasks = [task("t1", "2026-08-01T00:00:00.000Z")];
    const rows = [auditRow("t1", null, "started", "2026-08-10T00:00:00.000Z")];
    expect(deriveStatusAges(tasks, rows, NOW).get("t1")!.since).toBe("created");
  });
});

describe("deriveStatusAges — real status transitions", () => {
  it("anchors on the transition timestamp, not created_at", () => {
    const tasks = [task("t1", "2026-01-01T00:00:00.000Z")];
    const rows = [auditRow("t1", "backlog", "started", "2026-08-10T00:00:00.000Z")];
    const age = deriveStatusAges(tasks, rows, NOW).get("t1")!;
    expect(age.since).toBe("status_change");
    expect(age.changedAt).toBe("2026-08-10T00:00:00.000Z");
    expect(age.days).toBe(5); // Aug 10 -> Aug 15
  });

  it("picks the MOST RECENT transition when a task moved several times", () => {
    const tasks = [task("t1", "2026-01-01T00:00:00.000Z")];
    const rows = [
      auditRow("t1", "backlog", "unstarted", "2026-08-01T00:00:00.000Z"),
      auditRow("t1", "unstarted", "started", "2026-08-12T00:00:00.000Z"),
      auditRow("t1", "started", "completed", "2026-08-05T00:00:00.000Z"), // out of order, still older
    ];
    const age = deriveStatusAges(tasks, rows, NOW).get("t1")!;
    expect(age.changedAt).toBe("2026-08-12T00:00:00.000Z");
    expect(age.days).toBe(3);
  });

  it("a mixed batch of transition + non-transition rows still finds the real move", () => {
    const tasks = [task("t1", "2026-01-01T00:00:00.000Z")];
    const rows = [
      auditRow("t1", "started", "started", "2026-08-14T00:00:00.000Z"), // rename, same day, NOT a move
      auditRow("t1", "backlog", "started", "2026-08-01T00:00:00.000Z"), // the real move
    ];
    const age = deriveStatusAges(tasks, rows, NOW).get("t1")!;
    expect(age.since).toBe("status_change");
    expect(age.changedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("deriveStatusAges — batching across many tasks in one call", () => {
  it("computes independent ages for every task from a single shared audit-row batch", () => {
    const tasks = [
      task("t1", "2026-08-01T00:00:00.000Z"),
      task("t2", "2026-07-01T00:00:00.000Z"),
      task("t3", "2026-08-14T00:00:00.000Z"),
    ];
    const rows = [
      auditRow("t2", "backlog", "started", "2026-08-08T00:00:00.000Z"),
    ];
    const ages = deriveStatusAges(tasks, rows, NOW);
    expect(ages.size).toBe(3);
    expect(ages.get("t1")!.since).toBe("created");
    expect(ages.get("t2")!.since).toBe("status_change");
    expect(ages.get("t2")!.days).toBe(7);
    expect(ages.get("t3")!.days).toBe(1);
  });
});

describe("deriveStatusAges — edge cases", () => {
  it("clamps to 0 rather than going negative for a same-instant anchor", () => {
    const tasks = [task("t1", NOW.toISOString())];
    expect(deriveStatusAges(tasks, [], NOW).get("t1")!.days).toBe(0);
  });

  it("clamps to 0 rather than going negative when the anchor is (erroneously) in the future", () => {
    const tasks = [task("t1", "2026-09-01T00:00:00.000Z")];
    expect(deriveStatusAges(tasks, [], NOW).get("t1")!.days).toBe(0);
  });

  it("returns a Map entry for every task passed in, even with an empty audit batch", () => {
    const tasks = [task("t1", "2026-08-01T00:00:00.000Z"), task("t2", "2026-08-01T00:00:00.000Z")];
    expect(deriveStatusAges(tasks, []).size).toBe(2);
  });
});

describe("STALE_STATUS_AGE_DAYS threshold", () => {
  it("is exported as the >14 day boundary consumers style distinctly", () => {
    expect(STALE_STATUS_AGE_DAYS).toBe(14);
  });
});
