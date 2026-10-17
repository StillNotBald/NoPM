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
 *
 * TRUNCATE (migration 0050): the two row triggers never fire for TRUNCATE (it
 * touches no rows), so immutability also needs (c) a statement-level BEFORE
 * TRUNCATE trigger on audit_log and (d) TRUNCATE revoked from anon and
 * authenticated on every public table, with default privileges changed so a
 * future table does not regain it. Both are required below, and no later
 * migration may undo either.
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
  // TRUNCATE guard (0050). A drop that is immediately re-created in the same file is fine (idempotent re-run).
  { label: "drops trg_audit_no_truncate", pattern: /drop trigger\s+(if exists\s+)?trg_audit_no_truncate\s+on\s+audit_log\s*;(?!\s*create trigger\s+trg_audit_no_truncate)/i },
  { label: "disables the truncate trigger on audit_log", pattern: /alter table audit_log\s+(disable|enable replica|enable always)\s+trigger\s+trg_audit_no_truncate/i },
  { label: "grants truncate to anon/authenticated/public", pattern: /\bgrant\s+[^;]*\btruncate\b[^;]*\s+to\s+[^;]*\b(anon|authenticated|public)\b/i },
  // `grant all` includes TRUNCATE, so a bulk or default `all` grant to the API roles re-opens it too.
  { label: "bulk-grants all/truncate on all tables to anon/authenticated/public", pattern: /\bgrant\s+[^;]*\b(truncate|all)\b[^;]*\s+on\s+all tables in schema\b[^;]*\s+to\s+[^;]*\b(anon|authenticated|public)\b/i },
  { label: "default-grants all/truncate on tables to anon/authenticated/public", pattern: /alter default privileges[^;]*\bgrant\s+[^;]*\b(truncate|all)\b[^;]*\s+on\s+tables\s+to\s+[^;]*\b(anon|authenticated|public)\b/i },
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

describe("audit_log TRUNCATE guard (migration 0050)", () => {
  const migrations = readMigrationsInOrder();
  const guard = migrations.find((m) => m.name.endsWith("_truncate_guard.sql"));
  // Comments stripped and whitespace squashed, so the assertions read statements, not prose.
  const squash = (sql: string) =>
    sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();

  it("the truncate-guard migration exists", () => {
    expect(guard, "no *_truncate_guard.sql migration").toBeDefined();
  });

  it("creates a statement-level BEFORE TRUNCATE trigger on audit_log that raises via nopm_audit_immutable()", () => {
    const sql = squash(guard!.sql);
    expect(sql).toMatch(
      /create trigger trg_audit_no_truncate before truncate on audit_log for each statement execute function nopm_audit_immutable\(\)/,
    );
  });

  it("revokes truncate (and references/trigger) from anon and authenticated on every existing public table", () => {
    const sql = squash(guard!.sql);
    const m = sql.match(/revoke ([a-z, ]+) on all tables in schema public from ([a-z, ]+);/);
    expect(m, "no 'revoke ... on all tables in schema public from ...' statement").not.toBeNull();
    const privs = m![1].split(",").map((x) => x.trim());
    const roles = m![2].split(",").map((x) => x.trim());
    expect(privs).toEqual(expect.arrayContaining(["truncate", "references", "trigger"]));
    expect(roles.sort()).toEqual(["anon", "authenticated"]);
  });

  it("changes the default privileges so a table created later does not regain truncate", () => {
    const sql = squash(guard!.sql);
    expect(sql).toMatch(
      /alter default privileges in schema public revoke [a-z, ]*truncate[a-z, ]* on tables from anon, authenticated/,
    );
  });

  it("no migration (the guard itself included) re-grants truncate or drops/disables the guard", () => {
    const violations: string[] = [];
    for (const { name, sql } of migrations.filter((m) => m.name >= guard!.name)) {
      for (const { label, pattern } of WEAKENING_PATTERNS) {
        if (pattern.test(sql)) violations.push(`${name}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("canary: the truncate patterns match the statements they claim to", () => {
    const hit = (label: string, sql: string) => WEAKENING_PATTERNS.find((p) => p.label === label)!.pattern.test(sql);
    expect(hit("drops trg_audit_no_truncate", "drop trigger trg_audit_no_truncate on audit_log;")).toBe(true);
    expect(
      hit(
        "drops trg_audit_no_truncate",
        "drop trigger if exists trg_audit_no_truncate on audit_log;\ncreate trigger trg_audit_no_truncate before truncate on audit_log",
      ),
    ).toBe(false);
    expect(hit("disables the truncate trigger on audit_log", "alter table audit_log disable trigger trg_audit_no_truncate;")).toBe(true);
    expect(hit("grants truncate to anon/authenticated/public", "grant truncate on all tables in schema public to authenticated;")).toBe(true);
    expect(hit("grants truncate to anon/authenticated/public", "grant select on tasks to authenticated;")).toBe(false);
    expect(hit("bulk-grants all/truncate on all tables to anon/authenticated/public", "grant all on all tables in schema public to anon, authenticated;")).toBe(true);
    expect(hit("bulk-grants all/truncate on all tables to anon/authenticated/public", "grant select on all tables in schema public to authenticated;")).toBe(false);
    expect(hit("default-grants all/truncate on tables to anon/authenticated/public", "alter default privileges in schema public grant all on tables to anon;")).toBe(true);
    expect(hit("default-grants all/truncate on tables to anon/authenticated/public", "alter default privileges in schema public revoke truncate on tables from anon;")).toBe(false);
  });
});
