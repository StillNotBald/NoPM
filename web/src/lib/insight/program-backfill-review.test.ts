/**
 * Backfill SQL review (L-01) — migrations are static SQL, never executed by
 * this test suite (no DB in vitest). This is the "reviewed" record the task
 * spec asks for: a machine-checked assertion that migration
 * 20260815000034_programs.sql's backfill keeps the shape it was reviewed
 * against, so a later hand-edit that silently breaks the create-then-link
 * flow, drops the per-workspace scoping, or removes the legacy column fails
 * CI instead of shipping quietly.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  __dirname,
  "../../../supabase/migrations/20260815000034_programs.sql",
);

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

describe("20260815000034_programs.sql — backfill review", () => {
  const sql = readMigration();

  it("creates the programs table before the backfill runs", () => {
    expect(sql).toMatch(/create table programs/i);
    expect(sql.indexOf("create table programs")).toBeLessThan(
      sql.indexOf("insert into programs"),
    );
  });

  it("adds projects.program_id as a nullable FK with ON DELETE SET NULL — deleting a program never deletes projects", () => {
    expect(sql).toMatch(/add column program_id uuid references programs\(id\) on delete set null/i);
  });

  it("keeps the legacy projects.program text column (deprecated, never dropped)", () => {
    expect(sql).not.toMatch(/drop column program\b/i);
    expect(sql).toMatch(/comment on column projects\.program is/i);
    expect(sql.toLowerCase()).toContain("deprecated");
  });

  it("backfill creates one program per DISTINCT non-null/non-blank (workspace_id, program) pair", () => {
    expect(sql).toMatch(/insert into programs \(workspace_id, code, name\)/i);
    expect(sql).toMatch(/select distinct workspace_id, program/i);
    expect(sql).toMatch(/where program is not null and trim\(program\) <> ''/i);
  });

  it("backfill scopes program creation per workspace (workspace_id carried through the SELECT)", () => {
    const insertBlock = sql.slice(
      sql.indexOf("insert into programs"),
      sql.indexOf("update projects pr"),
    );
    expect(insertBlock).toMatch(/p\.workspace_id/);
  });

  it("backfill links projects.program_id back by matching (workspace_id, program = name)", () => {
    const updateBlock = sql.slice(sql.indexOf("update projects pr"));
    expect(updateBlock).toMatch(/set program_id = pg\.id/i);
    expect(updateBlock).toMatch(/pr\.program = pg\.name/);
    expect(updateBlock).toMatch(/pr\.workspace_id = pg\.workspace_id/);
  });

  it("backfill code column is a slug: lowercased, non-alnum collapsed, trimmed, length-capped", () => {
    expect(sql).toMatch(/lower\(trim\(p\.program\)\)/i);
    expect(sql).toMatch(/regexp_replace\([^,]+, '\[\^a-z0-9\]\+', '-', 'g'\)/i);
    expect(sql).toMatch(/trim\(both '-' from/i);
    expect(sql).toMatch(/from 1 for 32/); // capped to match the zod `code` convention
  });

  it("RLS policies mirror projects' pattern from migration 0003 (workspace-scoped, viewer read-only)", () => {
    expect(sql).toMatch(/alter table programs enable row level security/i);
    expect(sql).toMatch(/create policy "read programs" {2}on programs for select using \(workspace_id = nopm_current_workspace\(\)\)/i);
    expect(sql).toMatch(/nopm_current_role\(\) <> 'viewer'/);
  });

  it("owner_id targets resource_members(id) — the corrected post-0019 identity model, not profiles(id)", () => {
    expect(sql).toMatch(/owner_id\s+uuid references resource_members\(id\)/i);
  });
});
