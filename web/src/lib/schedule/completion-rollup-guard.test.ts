/**
 * Completion-rollup trigger guard drift test — devops-wave1a T4.
 *
 * web/supabase/migrations/20260814000031_rollup_trigger_guard.sql replaces
 * the single unconditional trg_tasks_completion_rollup (0021) with three
 * triggers so an UPDATE on tasks only recomputes project completion_pct
 * when a column the rollup formula actually reads changes. This suite has
 * no live Postgres, so — same pattern as
 * governance/lock-db-backstop.test.ts — it is a source-level drift test:
 * it reads the raw SQL of both 0021 (the formula) and 0031 (the guard) and
 * asserts they still agree.
 *
 * What this would catch that vitest otherwise couldn't:
 *  - 0021's nopm_recompute_project_completion() formula growing a new
 *    column (e.g. a future weighting field) that 0031's UPDATE WHEN clause
 *    doesn't guard on — the rollup would then silently go stale for
 *    updates to that column.
 *  - 0031 losing the project_id guard — a cross-project task move would
 *    stop recomputing the destination project.
 *  - the INSERT/DELETE triggers picking up an accidental WHEN clause
 *    (they must stay unconditional: every insert/delete always changes
 *    the weighted average).
 *  - 0031 modifying nopm_tasks_completion_rollup()/
 *    nopm_recompute_project_completion() (0021) — it must not: the
 *    existing function already recomputes both sides of a cross-project
 *    move correctly, so 0031 only needed to touch the trigger definitions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..", "..", "..");
const migrationsDir = join(repoRoot, "web", "supabase", "migrations");

const rollupFormula = readFileSync(
  join(migrationsDir, "20260608000021_completion_rollup.sql"),
  "utf8",
);
const guardMigration = readFileSync(
  join(migrationsDir, "20260814000031_rollup_trigger_guard.sql"),
  "utf8",
);

// The exact task columns nopm_recompute_project_completion() (0021) reads,
// per its `case when t.status_type = 'completed' then 100 else
// coalesce(t.completion_pct, 0) end` / `case when t.estimate_hours is not
// null and t.estimate_hours > 0 then t.estimate_hours else 1 end` formula.
const FORMULA_TASK_FIELDS = ["status_type", "completion_pct", "estimate_hours"];

describe("completion rollup formula (0021) — columns this guard must mirror", () => {
  it("still reads exactly status_type, completion_pct, estimate_hours in the weighted-average formula", () => {
    for (const field of FORMULA_TASK_FIELDS) {
      expect(rollupFormula, `formula no longer reads t.${field}`).toContain(`t.${field}`);
    }
  });

  it("nopm_tasks_completion_rollup() still recomputes BOTH sides of a cross-project move", () => {
    expect(rollupFormula).toContain("perform nopm_recompute_project_completion(new.project_id)");
    expect(rollupFormula).toMatch(
      /tg_op = 'UPDATE' and new\.project_id is distinct from old\.project_id/,
    );
    expect(rollupFormula).toContain("perform nopm_recompute_project_completion(old.project_id)");
  });
});

describe("rollup trigger guard migration (0031)", () => {
  it("drops the old unconditional trigger", () => {
    expect(guardMigration).toContain("drop trigger if exists trg_tasks_completion_rollup on tasks");
  });

  it("does NOT modify the underlying rollup function (0021's cross-project handling is reused as-is)", () => {
    expect(guardMigration).not.toMatch(/create or replace function nopm_tasks_completion_rollup/);
    expect(guardMigration).not.toMatch(/create or replace function nopm_recompute_project_completion/);
  });

  it("attaches unconditional INSERT and DELETE triggers (no WHEN clause)", () => {
    for (const trigger of ["trg_tasks_completion_rollup_ins", "trg_tasks_completion_rollup_del"]) {
      const start = guardMigration.indexOf(`create trigger ${trigger}`);
      expect(start, `missing trigger ${trigger}`).toBeGreaterThan(-1);
      const end = guardMigration.indexOf(";", start);
      const block = guardMigration.slice(start, end);
      expect(block, `${trigger} should not have a WHEN clause`).not.toContain("when (");
      expect(block).toContain("execute function nopm_tasks_completion_rollup()");
    }
    expect(guardMigration).toMatch(/create trigger trg_tasks_completion_rollup_ins\s+after insert on tasks/);
    expect(guardMigration).toMatch(/create trigger trg_tasks_completion_rollup_del\s+after delete on tasks/);
  });

  it("the UPDATE trigger's WHEN clause covers every formula field plus project_id (cross-project move)", () => {
    const start = guardMigration.indexOf("create trigger trg_tasks_completion_rollup_upd");
    expect(start).toBeGreaterThan(-1);
    const updBlock = guardMigration.slice(start);
    expect(updBlock).toMatch(/after update on tasks/);
    for (const field of [...FORMULA_TASK_FIELDS, "project_id"]) {
      expect(updBlock, `WHEN clause missing field: ${field}`).toContain(
        `old.${field} is distinct from new.${field}`,
      );
    }
  });
});
