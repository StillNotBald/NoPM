/**
 * Project-lock DB backstop drift test — devops-wave1a T2.
 *
 * The DB-level backstop (web/supabase/migrations/
 * 20260814000028_project_lock_enforcement.sql) exists to keep enforcing the
 * "schedule frozen, work continues" rule even if an API route ever forgets
 * to call assertProjectUnlocked() (lock.ts, T1). It cannot be exercised
 * end-to-end here — this suite has no live Postgres — so instead it is a
 * source-level drift test: it reads the migration's raw SQL text (and the
 * two route files this wave touched to wire the legitimate bypass path) and
 * asserts the pieces that *would* silently rot are still present and still
 * agree with lock.ts's authoritative field lists.
 *
 * What this test would catch that vitest otherwise couldn't:
 *  - a future edit to SCHEDULE_SHAPE_TASK_FIELDS / SCHEDULE_SHAPE_MILESTONE_FIELDS
 *    (lock.ts) that isn't mirrored into the trigger's WHEN clause — the DB
 *    backstop would then silently under-enforce a newly-added schedule field.
 *  - the migration losing one of its six triggers (tasks x3, milestones x3,
 *    task_dependencies x2 — 8 total) or the bypass/errcode contract.
 *  - the rebaseline apply route regressing back to the per-row `.update()`
 *    loop this wave replaced (the whole reason that loop couldn't carry a
 *    transaction-local bypass).
 *  - the deletion-approve route losing the P0010 → RuleError mapping this
 *    wave added.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULE_SHAPE_TASK_FIELDS, SCHEDULE_SHAPE_MILESTONE_FIELDS } from "./lock";

const repoRoot = join(__dirname, "..", "..", "..", "..");
const migrationPath = join(
  repoRoot,
  "web",
  "supabase",
  "migrations",
  "20260814000028_project_lock_enforcement.sql",
);
const migration = readFileSync(migrationPath, "utf8");

const applyRoutePath = join(
  repoRoot,
  "web",
  "src",
  "app",
  "api",
  "rebaselines",
  "[id]",
  "apply",
  "route.ts",
);
const applyRoute = readFileSync(applyRoutePath, "utf8");

// The deletion-approve RPC error mapping lives in the governed decision path
// (src/lib/governance/decide.ts, approveDeletion) since the approve route
// became a thin wrapper over it (2026-10-16 principal four-eyes).
const approveRoutePath = join(repoRoot, "web", "src", "lib", "governance", "decide.ts");
const approveRoute = readFileSync(approveRoutePath, "utf8");

describe("project-lock DB backstop migration (0028)", () => {
  it("defines the required trigger function and bypass/errcode contract", () => {
    expect(migration).toMatch(/create or replace function nopm_assert_project_unlocked\(\)/);
    expect(migration).toMatch(/returns trigger/);
    expect(migration).toContain("errcode = 'P0010'");
    expect(migration).toContain("PROJECT_LOCKED");
    expect(migration).toContain("current_setting('nopm.lock_bypass', true)");
  });

  it("attaches all 8 backstop triggers (tasks x3, milestones x3, task_dependencies x2)", () => {
    const expected = [
      "trg_lock_backstop_tasks_ins",
      "trg_lock_backstop_tasks_del",
      "trg_lock_backstop_tasks_upd",
      "trg_lock_backstop_milestones_ins",
      "trg_lock_backstop_milestones_del",
      "trg_lock_backstop_milestones_upd",
      "trg_lock_backstop_task_deps_ins",
      "trg_lock_backstop_task_deps_del",
    ];
    for (const trigger of expected) {
      expect(migration, `missing trigger ${trigger}`).toContain(`create trigger ${trigger}`);
    }
  });

  it("the tasks UPDATE trigger's WHEN clause covers every SCHEDULE_SHAPE_TASK_FIELDS entry", () => {
    const updBlock = migration.slice(
      migration.indexOf("create trigger trg_lock_backstop_tasks_upd"),
      migration.indexOf("-- ── 3. Triggers — milestones"),
    );
    for (const field of SCHEDULE_SHAPE_TASK_FIELDS) {
      expect(updBlock, `WHEN clause missing task field: ${field}`).toContain(`old.${field} is distinct from new.${field}`);
    }
  });

  it("the milestones UPDATE trigger's WHEN clause covers every SCHEDULE_SHAPE_MILESTONE_FIELDS entry", () => {
    const updBlock = migration.slice(
      migration.indexOf("create trigger trg_lock_backstop_milestones_upd"),
      migration.indexOf("-- ── 4. Triggers — task_dependencies"),
    );
    for (const field of SCHEDULE_SHAPE_MILESTONE_FIELDS) {
      expect(updBlock, `WHEN clause missing milestone field: ${field}`).toContain(
        `old.${field} is distinct from new.${field}`,
      );
    }
  });

  it("tasks/milestones INSERT and DELETE triggers are unconditional (no WHEN clause)", () => {
    for (const trigger of [
      "trg_lock_backstop_tasks_ins",
      "trg_lock_backstop_tasks_del",
      "trg_lock_backstop_milestones_ins",
      "trg_lock_backstop_milestones_del",
      "trg_lock_backstop_task_deps_ins",
      "trg_lock_backstop_task_deps_del",
    ]) {
      const start = migration.indexOf(`create trigger ${trigger}`);
      const end = migration.indexOf(";", start);
      const block = migration.slice(start, end);
      expect(block, `${trigger} should not have a WHEN clause`).not.toContain("when (");
    }
  });

  it("provides a transaction-local rebaseline-apply bypass function", () => {
    expect(migration).toMatch(/create or replace function nopm_apply_rebaseline_snapshot/);
    expect(migration).toContain("set_config('nopm.lock_bypass', 'on', true)");
  });

  it("does NOT modify or bypass nopm_commit_task_deletion (locked-project delete must still fail)", () => {
    expect(migration).not.toMatch(/create or replace function nopm_commit_task_deletion/);
  });
});

describe("rebaseline apply route wired to the bypass RPC (not a per-row update loop)", () => {
  it("calls the atomic nopm_apply_rebaseline RPC, which wraps the bypass snapshot (migration 0062)", () => {
    expect(applyRoute).toContain('db.rpc("nopm_apply_rebaseline"');
    expect(applyRoute).toMatch(/p_rebaseline_id:\s*params\.id/);
    expect(applyRoute).toMatch(/p_workspace_id:\s*actor\.workspaceId/);
    const m0062 = readFileSync(
      join(__dirname, "..", "..", "..", "supabase", "migrations", "20261017000062_rebaseline_apply_unlock_atomic.sql"),
      "utf8",
    );
    expect(m0062).toContain("perform nopm_apply_rebaseline_snapshot(");
  });

  it("no longer contains the old per-row milestone/task update loop", () => {
    expect(applyRoute).not.toContain('.from("milestones")');
    expect(applyRoute).not.toContain('.from("tasks")');
  });
});

describe("deletion-request approve path (decide.ts) maps PROJECT_LOCKED to a 422 RuleError", () => {
  it("maps errcode P0010 / message PROJECT_LOCKED to RuleError with the exact governance message", () => {
    expect(approveRoute).toMatch(/PROJECT_LOCKED.*error\.code === "P0010"|error\.code === "P0010"/);
    // Q-GOV-20: the request is closed (audited) and the message says how to continue.
    expect(approveRoute).toContain(
      "Closed: the project was locked after this was requested. Raise it again if still needed.",
    );
    expect(approveRoute).toMatch(/throw new RuleError\(PROJECT_LOCKED_CLOSED_MESSAGE, "project_locked"\)/);
  });

  it("the new mapping sits alongside the existing NOT_FOUND/ALREADY_DECIDED/SELF_APPROVAL mappings", () => {
    expect(approveRoute).toContain("NOT_FOUND");
    expect(approveRoute).toContain("ALREADY_DECIDED");
    expect(approveRoute).toContain("SELF_APPROVAL");
    expect(approveRoute).toContain("PROJECT_LOCKED");
  });
});
