import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Immutability-trigger regression test (R-83).
 *
 * audit_log is append-only by design: every mutation writes exactly one row
 * via writeAudit, and that row must never be editable or deletable after
 * the fact — that's what makes the Trust Center's audit stream trustworthy.
 * Enforcement lives entirely in the DB (nopm_audit_immutable() + the two
 * BEFORE triggers below), so a migration author could silently defeat it
 * with a later migration (a DROP TRIGGER, a DISABLE TRIGGER, dropping the
 * function, or a policy that grants UPDATE/DELETE on audit_log). This test
 * reads every migration file in order and asserts the guard is (a) created
 * once and (b) never subsequently weakened.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

function readMigrationsInOrder(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort() // filenames are timestamp-prefixed, so lexical sort == chronological order
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));
}

const WEAKENING_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "drops trg_audit_no_update/delete", pattern: /drop trigger\s+(if exists\s+)?trg_audit_no_(update|delete)/i },
  { label: "disables triggers on audit_log", pattern: /alter table audit_log\s+disable trigger/i },
  { label: "drops nopm_audit_immutable()", pattern: /drop function\s+(if exists\s+)?nopm_audit_immutable/i },
  { label: "grants an update/delete policy on audit_log", pattern: /create policy [\s\S]*? on audit_log\s+for (update|delete)/i },
  // `for all` covers update+delete too; a policy with no `for` clause defaults to ALL.
  { label: "grants a FOR ALL policy on audit_log", pattern: /create policy [\s\S]*? on audit_log\s+for all\b/i },
  { label: "grants a policy on audit_log with no command clause (defaults to ALL)", pattern: /create policy [^;]*? on audit_log\s+(using|with check)\b/i },
  { label: "grants table-level update/delete on audit_log", pattern: /grant\s+(?:[^;]*\b(update|delete|all)\b[^;]*)\s+on\s+(?:table\s+)?audit_log\b/i },
];

describe("audit_log immutability trigger", () => {
  const migrations = readMigrationsInOrder();

  it("finds the migration files", () => {
    expect(migrations.length).toBeGreaterThan(20);
  });

  it("some migration creates nopm_audit_immutable() and both triggers on audit_log", () => {
    const all = migrations.map((m) => m.sql).join("\n");

    expect(all).toMatch(/create (or replace )?function nopm_audit_immutable\s*\(/i);
    expect(all).toMatch(/create trigger trg_audit_no_update\s+before update on audit_log/i);
    expect(all).toMatch(/create trigger trg_audit_no_delete\s+before delete on audit_log/i);
  });

  it("no migration ever weakens or removes the immutability guard", () => {
    const violations: string[] = [];

    for (const { name, sql } of migrations) {
      for (const { label, pattern } of WEAKENING_PATTERNS) {
        if (pattern.test(sql)) {
          violations.push(`${name}: ${label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
