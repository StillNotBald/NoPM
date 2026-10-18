/** Migration-text test for 0095 backup_owner (M6). Read-only SQL scan. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const strip = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const sql = strip(readFileSync(join(dir, "20261018000095_backup_owner.sql"), "utf8"));
const flat = sql.replace(/\s+/g, " ");

describe("0095 backup_owner", () => {
  it.each([
    ["projects", "backup_owner_id", "profiles"],
    ["risks", "backup_owner_id", "profiles"],
    ["issues", "backup_owner_id", "profiles"],
    ["tasks", "backup_assignee_id", "resource_members"],
  ])("adds %s.%s as a nullable FK to %s that is nulled on delete", (table, col, target) => {
    expect(flat).toContain(`alter table ${table} add column if not exists ${col} uuid references ${target}(id) on delete set null`);
    expect(flat).not.toMatch(new RegExp(`${col} uuid[^;]*not null`));
  });

  it("a task backup follows the assignee identity (resource_members), not profiles", () => {
    expect(flat).not.toMatch(/backup_assignee_id uuid references profiles/);
  });

  it("indexes each new column, partially", () => {
    for (const col of ["backup_owner_id", "backup_assignee_id"]) {
      expect(flat).toMatch(new RegExp(`create index if not exists idx_[a-z_]+ on [a-z_]+ [(]${col}[)] where ${col} is not null`));
    }
    expect(sql.match(/create index if not exists/g)).toHaveLength(4);
  });

  it("checks backup <> primary on all four tables, NOT VALID first, null-safe", () => {
    for (const t of ["projects", "risks", "issues"]) {
      expect(flat).toContain(`alter table ${t} add constraint ${t}_backup_differs check (backup_owner_id is null or owner_id is null or backup_owner_id <> owner_id) not valid`);
    }
    expect(flat).toContain("alter table tasks add constraint tasks_backup_differs check (backup_assignee_id is null or assignee_id is null or backup_assignee_id <> assignee_id) not valid");
  });

  it("validates each constraint in its own skip-on-failure block, after adding them", () => {
    expect(sql.indexOf("validate constraint")).toBeGreaterThan(sql.indexOf("not valid"));
    for (const t of ["projects", "risks", "issues", "tasks"]) {
      expect(flat).toMatch(new RegExp(`begin alter table ${t} validate constraint ${t}_backup_differs; exception when others then raise notice`));
    }
  });

  it("is additive: no backfill, no data change, no drop, and no trigger touched", () => {
    expect(sql).not.toMatch(/\bdelete from\b|\binsert into\b|\bupdate [a-z_]+ set\b/i);
    expect(sql).not.toMatch(/\btruncate\b|drop (table|column|type|constraint)/i);
    expect(sql).not.toMatch(/\b(disable|enable) trigger\b|create (or replace )?trigger|drop trigger/i);
  });
});
