import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Migration-text test for 0071 (audit_log.principal_id): additive, nullable, immutability untouched. */
const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const sql = readFileSync(join(dir, "20261017000071_audit_principal.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("migration 0071 audit_principal", () => {
  it("adds a nullable uuid principal_id idempotently", () => {
    expect(code).toMatch(/alter table audit_log add column if not exists principal_id uuid\s*;/i);
    expect(code).not.toMatch(/principal_id uuid\s+not null/i);
  });
  it("has no foreign key, default, backfill or destructive statement", () => {
    expect(code).not.toMatch(/references/i);
    expect(code).not.toMatch(/\bdefault\b/i);
    expect(code).not.toMatch(/\b(update|delete|truncate|drop)\b/i);
  });
  it("does not touch the immutability triggers or grants", () => {
    expect(code).not.toMatch(/trigger|nopm_audit_immutable|grant|policy/i);
  });
});
