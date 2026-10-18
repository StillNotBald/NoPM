import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ANCHOR_TABLE_SQL } from "./bootstrap-sql";

const web = join(__dirname, "..", "..", "..", "..");
/** The repo is checked out with CRLF on Windows; compare as LF. */
const read = (...p: string[]) => readFileSync(join(web, ...p), "utf8").split("\r\n").join("\n");
const migration = read("supabase", "migrations", "20261018000112_audit_anchor_receipts.sql");
const anchorDb = read("anchor-db", "001_audit_anchors.sql");
const code = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("migration 0112 audit_anchor_receipts (R-170)", () => {
  const sql = code(migration);

  it("is additive and idempotent: one new table, if not exists, nothing destructive, no backfill", () => {
    expect(sql).toMatch(/create table if not exists audit_anchor_receipts/);
    expect(sql).not.toMatch(/\b(drop|truncate)\s+(table|column|function|trigger)/i);
    expect(sql).not.toMatch(/\balter table (?!audit_anchor_receipts)\w+/i);
    expect(sql).not.toMatch(/\b(insert into|update\s+\w+\s+set|delete from)\b/i);
    expect(sql).toMatch(/drop policy if exists "read audit_anchor_receipts"/);
  });

  it("holds one row per workspace with the streak columns", () => {
    expect(sql).toMatch(/workspace_id\s+uuid primary key references workspaces\(id\) on delete cascade/);
    for (const col of ["status", "chain_seq", "head_hash", "row_count", "anchored_at", "error_text", "streak_started_at"]) {
      expect(sql).toContain(col);
    }
  });

  it("adds the status CHECK not valid and validates it with a RAISE (audit G6)", () => {
    expect(sql).toMatch(/check \(status in \('anchored', 'failed', 'mismatch'\)\) not valid/);
    expect(sql).toMatch(/validate constraint audit_anchor_receipts_status_check/);
    expect(sql).toMatch(/raise exception 'audit_anchor_receipts_status_check could not be validated/);
  });

  it("is locked down like 0048: RLS on, select for admin and manager only, no write policy, no browser write grant (PR-28)", () => {
    expect(sql).toMatch(/alter table audit_anchor_receipts enable row level security/);
    expect(sql).toMatch(/revoke all on audit_anchor_receipts from anon/);
    expect(sql).toMatch(/revoke insert, update, delete, truncate on audit_anchor_receipts from authenticated/);
    expect(sql).toMatch(/grant select on audit_anchor_receipts to authenticated/);
    const policies = [...sql.matchAll(/create policy "[^"]+" on audit_anchor_receipts\s+for (\w+)/g)].map((m) => m[1]);
    expect(policies).toEqual(["select"]);
    expect(sql).toMatch(/p\.role in \('admin', 'manager'\)/);
    expect(sql).toMatch(/workspace_id = nopm_current_workspace\(\)/);
  });

  it("states its rollback and that the table is never evidence", () => {
    expect(migration).toMatch(/ROLLBACK/);
    expect(migration).toMatch(/NEVER read to decide a\s+comparison/);
  });

  it("is the only 0112 and sits after 0111", () => {
    const files = readdirSync(join(web, "supabase", "migrations")).filter((f) => f.startsWith("20261018000112_"));
    expect(files).toEqual(["20261018000112_audit_anchor_receipts.sql"]);
  });
});

describe("anchor database schema (web/anchor-db/001_audit_anchors.sql)", () => {
  it("contains the sink's bootstrap SQL verbatim, so the file and the first-use path cannot drift", () => {
    expect(anchorDb).toContain(ANCHOR_TABLE_SQL);
  });

  it("is append-only: unique (workspace_id, chain_seq) and triggers refuse update, delete and truncate", () => {
    expect(ANCHOR_TABLE_SQL).toMatch(/unique \(workspace_id, chain_seq\)/);
    expect(ANCHOR_TABLE_SQL).toMatch(/before update or delete on audit_anchors/);
    expect(ANCHOR_TABLE_SQL).toMatch(/before truncate on audit_anchors/);
    expect(ANCHOR_TABLE_SQL).toMatch(/raise exception 'audit_anchors is append-only/);
  });

  it("grants the app role INSERT and SELECT only (D12)", () => {
    const grants = [...code(anchorDb).matchAll(/grant ([a-z, ]+) on (?:sequence )?(\w+) to nopm_anchor/gi)].map((m) => `${m[1]}|${m[2]}`);
    expect(grants).toEqual(["select, insert|audit_anchors", "usage|audit_anchors_id_seq"]);
    expect(code(anchorDb)).not.toMatch(/grant (all|update|delete|truncate)/i);
  });

  it("is create-if-missing so it can be re-run", () => {
    expect(ANCHOR_TABLE_SQL).toMatch(/create table if not exists audit_anchors/);
    expect(ANCHOR_TABLE_SQL).toMatch(/create or replace function audit_anchors_append_only/);
    expect(ANCHOR_TABLE_SQL).toMatch(/if not exists \(select 1 from pg_trigger/);
  });
});
