/**
 * Validate principal-distinct CHECKs - migration-text drift test (migration 0115).
 * 0045 added cr_principal_distinct / deletion_principal_distinct NOT VALID; 0089 validates them best-effort and
 * swallows failures. 0115 validates them for good: re-runnable and loud.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261020000115_validate_principal_distinct.sql"),
  "utf8",
);
const code = sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");

describe("0115 validate principal-distinct", () => {
  it("covers both constraints on their tables", () => {
    expect(code).toContain("'change_requests'");
    expect(code).toContain("'cr_principal_distinct'");
    expect(code).toContain("'deletion_requests'");
    expect(code).toContain("'deletion_principal_distinct'");
  });
  it("is re-runnable: skips a constraint that is already validated", () => {
    expect(code).toMatch(/not convalidated/);
    expect(code).toMatch(/continue;/);
  });
  it("fails loudly with a count instead of swallowing the error", () => {
    expect(code).toMatch(/raise exception '0115: cannot validate/);
    expect(code).not.toMatch(/exception when others/i);
  });
  it("validates with VALIDATE CONSTRAINT and drops nothing", () => {
    expect(code).toMatch(/validate constraint/);
    expect(code).not.toMatch(/\bdrop\b|\bdelete\b|\btruncate\b/i);
  });
});
