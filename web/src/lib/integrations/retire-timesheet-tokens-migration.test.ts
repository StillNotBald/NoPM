/** Migration-text test for 0076: open 'timesheet' action tokens are retired (F10). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const text = readFileSync(join(dir, "20261018000076_retire_timesheet_action_tokens.sql"), "utf8");
const sql = text.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n").replace(/\s+/g, " ").trim();

describe("0076 retire timesheet action tokens", () => {
  it("is one data-only update that marks open timesheet tokens used", () => {
    expect(sql).toBe("update action_tokens set used_at = now() where approval_kind = 'timesheet' and used_at is null;");
  });
  it("is idempotent and touches no schema: nothing but that update", () => {
    expect(sql).not.toMatch(/\b(drop|delete from|truncate|alter table|create|insert)\b/i);
    expect(sql.match(/;/g)).toHaveLength(1);
  });
  it("only ever updates tokens that are still open (a used token is never rewritten)", () => {
    expect(sql).toContain("used_at is null");
  });
  it("says why, and that it is not reversible", () => {
    expect(text).toMatch(/decision 18/i);
    expect(text).toMatch(/ROLLBACK/);
  });
});
