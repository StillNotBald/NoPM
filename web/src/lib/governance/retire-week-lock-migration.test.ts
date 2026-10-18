/** Migration-text test for 0075: the week lock no longer blocks DELETE (decision 18). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const text = readFileSync(join(dir, "20261017000075_retire_week_lock_on_delete.sql"), "utf8");
const sql = text.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");

describe("0075 retire week lock on delete", () => {
  it("redefines only nopm_assert_week_unlocked, same attributes and grants", () => {
    expect(sql.match(/create or replace function (\w+)\(/g)).toEqual(["create or replace function nopm_assert_week_unlocked("]);
    expect(sql).toContain("set search_path = public");
    expect(sql).not.toMatch(/security definer/i);
    expect(sql).toContain("revoke execute on function nopm_assert_week_unlocked() from public, anon, authenticated;");
    expect(sql).toContain("grant  execute on function nopm_assert_week_unlocked() to service_role;");
  });
  it("DELETE returns old before any lock check; INSERT/UPDATE still raise P0011/P0012", () => {
    const del = sql.indexOf("tg_op = 'DELETE'");
    expect(del).toBeGreaterThan(-1);
    expect(sql.indexOf("return old;")).toBeGreaterThan(del);
    expect(sql.indexOf("return old;")).toBeLessThan(sql.indexOf("nopm_week_lock_state"));
    expect(sql).toContain("errcode = 'P0011'");
    expect(sql).toContain("errcode = 'P0012'");
  });
  it("changes no data and drops nothing; cites decision 18", () => {
    expect(sql).not.toMatch(/\b(drop|delete from|truncate|alter table|update\s+\w+\s+set)\b/i);
    expect(text).toMatch(/decision 18/i);
  });
});
