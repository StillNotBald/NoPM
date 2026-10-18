/** Migration-text test for 0080 (work-record rules). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const text = readFileSync(join(dir, "20261017000080_work_record_rules.sql"), "utf8");
const sql = text.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");

describe("0080 work-record rules", () => {
  it("is additive: no table or column removed, no row deleted (only the guarded replace of its OWN trigger)", () => {
    expect(sql).not.toMatch(/\b(truncate|delete from|drop table|drop column)\b/i);
    expect(sql.match(/drop trigger if exists (\w+)/g)).toEqual(["drop trigger if exists trg_tasks_content_updated"]);
  });
  it("Q-WRK-2: partial unique index on live clashes, created only when no duplicate exists", () => {
    expect(sql).toContain("uniq_live_clash_per_member_type");
    expect(sql).toMatch(/where resource_member_id is not null and status in \(''open'', ''investigating''\)/);
    expect(sql).toMatch(/having count\(\*\) > 1/);
    expect(sql).toContain("raise notice");
  });
  it("Q-WRK-19: risks.resolution, idempotent", () => {
    expect(sql).toContain("alter table risks add column if not exists resolution text");
  });
  it("Q-WRK-27: content_updated_at backfilled from updated_at, bumped only for name/dates/assignee", () => {
    expect(sql).toContain("add column if not exists content_updated_at timestamptz");
    expect(sql).toContain("update tasks set content_updated_at = updated_at where content_updated_at is null");
    for (const c of ["new.name", "new.start_date", "new.due_date", "new.assignee_id"]) expect(sql).toContain(c);
    expect(sql).not.toMatch(/new\.status/);
    expect(sql).toContain("revoke execute on function nopm_tasks_content_updated() from public, anon, authenticated;");
    expect(sql).toContain("grant  execute on function nopm_tasks_content_updated() to service_role;");
  });
  it("R3-1: the backfill runs with trg_tasks_updated disabled and re-enabled (updated_at untouched)", () => {
    const off = sql.indexOf("alter table tasks disable trigger trg_tasks_updated;");
    const fill = sql.indexOf("update tasks set content_updated_at = updated_at where content_updated_at is null");
    const on = sql.indexOf("alter table tasks enable trigger trg_tasks_updated;");
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(fill);
    expect(fill).toBeLessThan(on);
  });
  it("redefines no existing function", () => {
    expect(sql.match(/create or replace function (\w+)\(/g)).toEqual(["create or replace function nopm_tasks_content_updated("]);
  });
});
