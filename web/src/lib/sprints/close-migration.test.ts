/** Migration-text test for 0086 (atomic sprint close + change-request consumption). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const text = readFileSync(join(dir, "20261017000086_sprint_close_budget_cr_consumption.sql"), "utf8");
const sql = text.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");

describe("0086 sprint close + change-request consumption", () => {
  it("is additive: nothing removed", () => {
    expect(sql).not.toMatch(/\b(delete from|drop |truncate)\b/i);
  });
  it("adds the consumption columns idempotently", () => {
    expect(sql).toContain("add column if not exists budget_consumed_at timestamptz");
    expect(sql).toContain("add column if not exists budget_consumed_by uuid");
  });
  it("close is one function: lock, guards, snapshot, move, one audit row, service_role only", () => {
    expect(sql.match(/create or replace function (\w+)\(/g)).toEqual(["create or replace function nopm_close_sprint("]);
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = public");
    expect(sql).toMatch(/from sprints\s+where id = p_sprint_id and workspace_id = p_workspace_id\s+for update/);
    for (const c of ["SPRINT_NOT_ACTIVE", "UNFINISHED_TASKS", "INVALID_DESTINATION"]) expect(sql).toContain(c);
    expect(sql).toContain("update tasks set sprint_id = v_dest_id");
    expect(sql.match(/insert into audit_log/g)).toHaveLength(1);
    expect(sql).toContain("'sprint.closed'");
    expect(sql).toContain(
      "revoke execute on function nopm_close_sprint(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;",
    );
    expect(sql).toContain(
      "grant  execute on function nopm_close_sprint(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) to service_role;",
    );
  });
  it("uses errcodes no earlier migration uses", () => {
    for (const c of ["P0025", "P0026", "P0027"]) expect(sql).toContain(c);
  });
});
