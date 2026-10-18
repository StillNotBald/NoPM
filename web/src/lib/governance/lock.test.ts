/**
 * Project-lock (baseline freeze) application-layer guard — devops-wave1a T1.
 *
 * Covers:
 *  - assertProjectUnlocked: locked / unlocked / missing-project outcomes,
 *    the onBlocked callback firing before the throw, and its fail-soft
 *    swallowing of audit-write errors.
 *  - touchesScheduleShape: the intersection helper routes use to decide
 *    whether a PATCH body counts as a schedule-shape change.
 *  - Field-classification completeness: every field TaskUpdateSchema can
 *    actually receive must land in exactly one of {schedule-shape, allowed}
 *    — so a future schema addition that nobody classifies fails this test
 *    instead of silently going unguarded (or wrongly guarded).
 */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertProjectUnlocked,
  touchesScheduleShape,
  changedScheduleShapeFields,
  SCHEDULE_FIELD_KIND,
  SCHEDULE_SHAPE_PROJECT_FIELDS,
  SCHEDULE_SHAPE_TASK_FIELDS,
  SCHEDULE_SHAPE_MILESTONE_FIELDS,
} from "./lock";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { TaskUpdateSchema } from "@/app/api/tasks/_schema";
import { updateMilestoneSchema } from "@/app/api/milestones/_schema";
import { updateProjectSchema } from "@/app/api/projects/_schema";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const WORKSPACE_ID = "ws_1";

type FakeProjectRow = { id: string; is_locked: boolean | null; lock_reason: string | null } | null;

/** A minimal fake admin client covering exactly the chain assertProjectUnlocked calls. */
function fakeDb(row: FakeProjectRow, error: { message: string } | null = null) {
  const maybeSingle = vi.fn(async () => ({ data: row, error }));
  const eq2 = vi.fn(() => ({ maybeSingle }));
  const eq1 = vi.fn(() => ({ eq: eq2 }));
  const select = vi.fn(() => ({ eq: eq1 }));
  const from = vi.fn((table: string) => {
    if (table !== "projects") throw new Error(`unexpected table: ${table}`);
    return { select };
  });
  return { db: { from } as unknown as SupabaseClient, from, select, eq1, eq2, maybeSingle };
}

// ---------------------------------------------------------------------------
// assertProjectUnlocked
// ---------------------------------------------------------------------------
describe("assertProjectUnlocked", () => {
  it("returns the project row when unlocked", async () => {
    const { db } = fakeDb({ id: PROJECT_ID, is_locked: false, lock_reason: null });
    await expect(assertProjectUnlocked(db, PROJECT_ID, WORKSPACE_ID)).resolves.toEqual({
      id: PROJECT_ID,
      is_locked: false,
      lock_reason: null,
    });
  });

  it("throws NotFoundError when the project does not exist (or isn't in this workspace)", async () => {
    const { db } = fakeDb(null);
    await expect(assertProjectUnlocked(db, PROJECT_ID, WORKSPACE_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws a RuleError with code project_locked and the exact governance message when locked", async () => {
    const { db } = fakeDb({ id: PROJECT_ID, is_locked: true, lock_reason: "Q3 baseline" });
    const err = await assertProjectUnlocked(db, PROJECT_ID, WORKSPACE_ID).catch((e) => e);
    expect(err).toBeInstanceOf(RuleError);
    expect(err.code).toBe("project_locked");
    expect(err.status).toBe(422);
    expect(err.message).toBe(
      "Project is locked (baseline frozen) — ask a manager or admin to unlock it, or propose a rebaseline.",
    );
  });

  it("scopes the lookup by id AND workspace_id", async () => {
    const { db, eq1, eq2 } = fakeDb({ id: PROJECT_ID, is_locked: false, lock_reason: null });
    await assertProjectUnlocked(db, PROJECT_ID, WORKSPACE_ID);
    expect(eq1).toHaveBeenCalledWith("id", PROJECT_ID);
    expect(eq2).toHaveBeenCalledWith("workspace_id", WORKSPACE_ID);
  });

  it("rethrows a plain Error when the fetch itself errors", async () => {
    const { db } = fakeDb(null, { message: "connection reset" });
    await expect(assertProjectUnlocked(db, PROJECT_ID, WORKSPACE_ID)).rejects.toThrow(
      "connection reset",
    );
  });

  it("calls onBlocked before throwing when locked, and never calls it when unlocked", async () => {
    const onBlocked = vi.fn(async () => {});

    const { db: unlockedDb } = fakeDb({ id: PROJECT_ID, is_locked: false, lock_reason: null });
    await assertProjectUnlocked(unlockedDb, PROJECT_ID, WORKSPACE_ID, onBlocked);
    expect(onBlocked).not.toHaveBeenCalled();

    const { db: lockedDb } = fakeDb({ id: PROJECT_ID, is_locked: true, lock_reason: null });
    await expect(assertProjectUnlocked(lockedDb, PROJECT_ID, WORKSPACE_ID, onBlocked)).rejects.toBeInstanceOf(
      RuleError,
    );
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it("is fail-soft: an onBlocked (audit write) failure never masks the RuleError or throws instead of it", async () => {
    const { db } = fakeDb({ id: PROJECT_ID, is_locked: true, lock_reason: null });
    const onBlocked = vi.fn(async () => {
      throw new Error("audit_log insert failed");
    });

    const err = await assertProjectUnlocked(db, PROJECT_ID, WORKSPACE_ID, onBlocked).catch((e) => e);
    expect(err).toBeInstanceOf(RuleError);
    expect(err.code).toBe("project_locked");
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// touchesScheduleShape
// ---------------------------------------------------------------------------
describe("touchesScheduleShape", () => {
  it("is false for a body containing only non-schedule fields", () => {
    expect(touchesScheduleShape({ status: "started", priority: "high" }, SCHEDULE_SHAPE_TASK_FIELDS)).toBe(
      false,
    );
  });

  it("is true when the body includes even one schedule-shape field alongside others", () => {
    expect(
      touchesScheduleShape({ status: "started", due_date: "2026-09-01" }, SCHEDULE_SHAPE_TASK_FIELDS),
    ).toBe(true);
  });

  it("is false for an empty body", () => {
    expect(touchesScheduleShape({}, SCHEDULE_SHAPE_TASK_FIELDS)).toBe(false);
  });

  it("works with the milestone field list too", () => {
    expect(touchesScheduleShape({ target_date: "2026-09-01" }, SCHEDULE_SHAPE_MILESTONE_FIELDS)).toBe(true);
    expect(touchesScheduleShape({ status: "on_track" }, SCHEDULE_SHAPE_MILESTONE_FIELDS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Field-classification completeness — TaskUpdateSchema
// ---------------------------------------------------------------------------
//
// Fields NOT named in the task-lock spec's explicit "ALLOWED under lock" list
// (status, status_type, completion_pct, checklist, acceptance_criteria, name,
// description, labels, priority, assignee_id, sort_order) but that also don't
// reshape the schedule — story_points (an estimate variant, informational —
// unlike estimate_hours it doesn't feed the CPM scheduler) and blocked_by
// (a soft advisory pointer; the governed dependency graph is task_dependencies,
// guarded separately in tasks/[id]/dependencies) — are classified here as
// allowed. Any newly-added TaskUpdateSchema field must be added to one of
// these two lists or the coverage test below fails.
const ALLOWED_TASK_FIELDS = [
  "status",
  "status_type",
  "completion_pct",
  "checklist",
  "acceptance_criteria",
  "name",
  "description",
  "labels",
  "priority",
  "assignee_id",
  "sort_order",
  "story_points",
  "blocked_by",
  // complement seam (0041, R-81) — the external system a task mirrors is
  // metadata, not schedule shape; editable live under a locked baseline.
  "source",
  "external_ref",
  "external_url",
  // Optimistic concurrency (R-90) — a precondition on the write, not a
  // schedule-shape field itself; stripped before the DB update either way.
  "expected_updated_at",
] as const;

describe("TaskUpdateSchema field classification (schedule-shape vs allowed)", () => {
  const taskFields = Object.keys(TaskUpdateSchema.shape);

  it("the two lists are disjoint", () => {
    const overlap = SCHEDULE_SHAPE_TASK_FIELDS.filter((f) =>
      (ALLOWED_TASK_FIELDS as readonly string[]).includes(f),
    );
    expect(overlap).toEqual([]);
  });

  it("every field TaskUpdateSchema can receive is classified in exactly one list", () => {
    const classified = new Set<string>([...SCHEDULE_SHAPE_TASK_FIELDS, ...ALLOWED_TASK_FIELDS]);
    const unclassified = taskFields.filter((f) => !classified.has(f));
    expect(unclassified).toEqual([]);
  });

  it("does not classify fields the schema doesn't actually have (catches stale entries)", () => {
    const taskFieldSet = new Set(taskFields);
    const staleAllowed = ALLOWED_TASK_FIELDS.filter((f) => !taskFieldSet.has(f));
    // project_id and the baseline_* pair are legitimate schedule-shape fields
    // that TaskUpdateSchema itself never carries (project_id is stripped from
    // the body before parsing; baseline_* are system-set only) — expected.
    const staleScheduleShape = SCHEDULE_SHAPE_TASK_FIELDS.filter(
      (f) => !taskFieldSet.has(f) && !["project_id", "baseline_start_date", "baseline_due_date"].includes(f),
    );
    expect(staleAllowed).toEqual([]);
    expect(staleScheduleShape).toEqual([]);
  });
});

describe("updateMilestoneSchema field classification (schedule-shape subset)", () => {
  it("both SCHEDULE_SHAPE_MILESTONE_FIELDS entries are real, updatable milestone fields", () => {
    const milestoneFields = new Set(Object.keys(updateMilestoneSchema.shape));
    for (const field of SCHEDULE_SHAPE_MILESTONE_FIELDS) {
      expect(milestoneFields.has(field)).toBe(true);
    }
  });
});

// ── R1/H1: the project row's own schedule shape ───────────────────────────

describe("SCHEDULE_SHAPE_PROJECT_FIELDS / changedScheduleShapeFields", () => {
  const current = {
    start_date: "2027-01-01",
    target_date: "2027-06-30",
    baseline_start_date: "2027-01-01",
    baseline_target_date: "2027-06-30",
    name: "Billing Migration",
  };

  it("lists exactly the four project schedule/baseline dates (mirrors the 0049 trigger WHEN clause)", () => {
    expect([...SCHEDULE_SHAPE_PROJECT_FIELDS].sort()).toEqual(
      ["baseline_start_date", "baseline_target_date", "start_date", "target_date"].sort(),
    );
  });

  it("flags a different date, whichever of the four it is", () => {
    for (const field of SCHEDULE_SHAPE_PROJECT_FIELDS) {
      expect(changedScheduleShapeFields({ [field]: "2029-01-01" }, current, SCHEDULE_SHAPE_PROJECT_FIELDS)).toEqual([field]);
    }
  });

  it("does not flag name / owner / RAG-style edits", () => {
    expect(changedScheduleShapeFields({ name: "Renamed", rag_status: "red" }, current, SCHEDULE_SHAPE_PROJECT_FIELDS)).toEqual([]);
  });

  it("echoing the stored value back is not a change (a form that re-sends the whole record)", () => {
    expect(changedScheduleShapeFields({ ...current, name: "Renamed" }, current, SCHEDULE_SHAPE_PROJECT_FIELDS)).toEqual([]);
  });

  it("compares dates by calendar day: an ISO timestamp for the same day is not a change", () => {
    expect(
      changedScheduleShapeFields({ target_date: "2027-06-30T00:00:00.000Z" }, current, SCHEDULE_SHAPE_PROJECT_FIELDS),
    ).toEqual([]);
  });

  it("clearing a set date IS a change; clearing an already-empty one is not", () => {
    expect(changedScheduleShapeFields({ baseline_target_date: null }, current, SCHEDULE_SHAPE_PROJECT_FIELDS)).toEqual([
      "baseline_target_date",
    ]);
    expect(
      changedScheduleShapeFields({ baseline_target_date: null }, { ...current, baseline_target_date: null }, SCHEDULE_SHAPE_PROJECT_FIELDS),
    ).toEqual([]);
  });

  it("setting a date where there was none IS a change", () => {
    expect(
      changedScheduleShapeFields({ start_date: "2027-02-01" }, { ...current, start_date: null }, SCHEDULE_SHAPE_PROJECT_FIELDS),
    ).toEqual(["start_date"]);
  });

  it("every field is a real updatable project field", () => {
    const projectFields = new Set(Object.keys(updateProjectSchema.shape));
    for (const field of SCHEDULE_SHAPE_PROJECT_FIELDS) expect(projectFields.has(field)).toBe(true);
  });
});

// ── R-CR P2-1: each field compares the way its column does ─────────────────

describe("changedScheduleShapeFields — per-field comparator (task + milestone shape)", () => {
  const MS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  // Same first ten characters as MS_A: a truncating comparator would call these equal.
  const MS_B = "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb";
  const task = {
    start_date: "2026-10-01",
    due_date: "2026-10-15",
    estimate_hours: 12.5,
    milestone_id: MS_A,
    name: "Migrate billing DB",
  };
  const changed = (input: Record<string, unknown>, current: Record<string, unknown> = task) =>
    changedScheduleShapeFields(input, current, SCHEDULE_SHAPE_TASK_FIELDS);

  it("classifies every field of the three schedule-shape lists (a new field cannot silently fall back to string compare)", () => {
    for (const field of [
      ...SCHEDULE_SHAPE_TASK_FIELDS,
      ...SCHEDULE_SHAPE_MILESTONE_FIELDS,
      ...SCHEDULE_SHAPE_PROJECT_FIELDS,
    ]) {
      expect(SCHEDULE_FIELD_KIND[field], field).toBeDefined();
    }
  });

  it("a full-record echo is no change", () => {
    expect(changed({ ...task })).toEqual([]);
    expect(changed({ ...task, due_date: "2026-10-15T00:00:00.000Z", estimate_hours: 12.5 })).toEqual([]);
  });

  it("dates compare by day, numbers by value, ids by the whole string", () => {
    expect(changed({ due_date: "2026-10-16" })).toEqual(["due_date"]);
    expect(changed({ due_date: "2026-10-15T23:59:59Z" })).toEqual([]);
    expect(changed({ estimate_hours: 13 })).toEqual(["estimate_hours"]);
    expect(changed({ estimate_hours: 12.5 }, { ...task, estimate_hours: "12.50" })).toEqual([]);
    expect(changed({ milestone_id: MS_B })).toEqual(["milestone_id"]);
    expect(changed({ milestone_id: MS_A })).toEqual([]);
  });

  it("null, undefined and the empty string are one and the same 'no value'", () => {
    const bare = { name: "x" }; // columns absent from the row = NULL
    expect(changed({ start_date: null, estimate_hours: null, milestone_id: null }, bare)).toEqual([]);
    expect(changed({ start_date: "", milestone_id: "" }, { start_date: null, milestone_id: undefined })).toEqual([]);
    expect(changed({ start_date: undefined })).toEqual([]);
  });

  it("setting a value where there was none, or clearing one, IS a change", () => {
    expect(changed({ estimate_hours: 4 }, { ...task, estimate_hours: null })).toEqual(["estimate_hours"]);
    expect(changed({ estimate_hours: null })).toEqual(["estimate_hours"]);
    expect(changed({ milestone_id: null })).toEqual(["milestone_id"]);
    expect(changed({ start_date: "2026-10-01" }, { ...task, start_date: null })).toEqual(["start_date"]);
  });

  it("zero hours is a value, not 'no value'", () => {
    expect(changed({ estimate_hours: 0 }, { ...task, estimate_hours: null })).toEqual(["estimate_hours"]);
    expect(changed({ estimate_hours: 0 }, { ...task, estimate_hours: 0 })).toEqual([]);
  });

  it("a non-numeric estimate never matches a stored number", () => {
    expect(changed({ estimate_hours: "twelve" })).toEqual(["estimate_hours"]);
  });

  it("reports every changed field, in list order, and ignores fields outside the list", () => {
    expect(changed({ name: "Renamed", milestone_id: MS_B, start_date: "2026-11-01", estimate_hours: 1 })).toEqual([
      "start_date",
      "estimate_hours",
      "milestone_id",
    ]);
  });

  it("works for the milestone list too: an ISO timestamp for the stored day is not a change", () => {
    const milestone = { start_date: null, target_date: "2027-03-01", baseline_target_date: "2027-03-01" };
    expect(
      changedScheduleShapeFields({ target_date: "2027-03-01T00:00:00.000Z" }, milestone, SCHEDULE_SHAPE_MILESTONE_FIELDS),
    ).toEqual([]);
    expect(
      changedScheduleShapeFields({ target_date: "2027-04-01T00:00:00.000Z" }, milestone, SCHEDULE_SHAPE_MILESTONE_FIELDS),
    ).toEqual(["target_date"]);
  });
});
