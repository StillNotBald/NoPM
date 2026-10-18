/** Migration 0084 - source-text drift test (no live Postgres in this suite). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "..", "..", "..", "supabase", "migrations", "20261017000084_workspace_time_zone_rebaseline_cards.sql"),
  "utf8",
)
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0084 workspace time zone + rebaseline cards", () => {
  it("adds workspaces.time_zone defaulting to Malaysia, idempotently", () => {
    expect(sql).toMatch(/add column if not exists time_zone text not null default 'Asia\/Kuala_Lumpur'/);
  });
  it("widens both approval_kind checks, keeping every old value", () => {
    for (const table of ["integration_deliveries", "action_tokens"]) {
      expect(sql).toMatch(new RegExp(`alter table ${table} drop constraint if exists ${table}_approval_kind_check`));
    }
    const kinds = sql.match(/'task_deletion', 'project_deletion', 'change_request', 'timesheet', 'rebaseline_signoff'/g);
    expect(kinds).toHaveLength(2);
  });
  it("is additive: no table or column removal, no truncate, no row delete", () => {
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate|delete\s+from/i);
  });
});

describe("0084 demo refund (Q-ACC-10)", () => {
  it("adds a service-role-only refund that never goes below zero", () => {
    expect(sql).toMatch(/create or replace function nopm_demo_rate_refund\(p_user uuid\)/);
    expect(sql).toMatch(/greatest\(count - 1, 0\)/);
    expect(sql).toMatch(/revoke execute on function nopm_demo_rate_refund\(uuid\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function nopm_demo_rate_refund\(uuid\) to service_role/);
  });
});
