/** Migration 0081 (mfa_grace) - source-text guard. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261017000081_mfa_grace.sql"), "utf8")
  .replace(/--[^\n]*/g, " ")
  .replace(/\s+/g, " ")
  .toLowerCase();

describe("0081 mfa_grace", () => {
  it("adds one nullable timestamptz column idempotently", () => {
    expect(sql).toContain("alter table profiles add column if not exists mfa_grace_started_at timestamptz;");
  });
  it("backfills only admins/managers and only NULLs", () => {
    expect(sql).toContain("where role::text in ('admin', 'manager') and mfa_grace_started_at is null");
  });
  it("trigger restarts the clock on promotion and clears it on demotion", () => {
    expect(sql).toContain("old.role::text not in ('admin', 'manager')");
    expect(sql).toContain("new.mfa_grace_started_at := null");
    expect(sql).toContain("before insert or update of role on profiles");
  });
  it("deletes no data and drops no table or column", () => {
    expect(sql).not.toMatch(/\btruncate\b|\bdelete from\b|drop table|drop column/);
  });
});
