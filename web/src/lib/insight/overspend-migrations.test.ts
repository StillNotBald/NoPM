import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(resolve(dir, f), "utf8");

describe("migration 0078 budget overspend level", () => {
  const sql = read("20261017000078_budget_overspend_level.sql");
  it("is additive, idempotent and does not validate old rows", () => {
    expect(sql).toMatch(/add column if not exists overspend_level text not null default 'ok'/);
    expect(sql).toMatch(/add column if not exists overspend_warn_pct int not null default 90/);
    expect(sql).toMatch(/not valid/);
    expect(sql).not.toMatch(/drop |delete from|truncate/i);
  });
});

describe("migration 0079 decision supersede loop guard", () => {
  const sql = read("20261017000079_decision_supersede_loop_guard.sql");
  it("adds a loop-guard trigger and nothing destructive", () => {
    expect(sql).toMatch(/create or replace function nopm_decisions_no_supersede_loop/);
    expect(sql).toMatch(/before insert or update of supersedes on decisions/);
    expect(sql).not.toMatch(/nopm_commit_project_deletion/);
    expect(sql).not.toMatch(/delete from|truncate/i);
  });
});
