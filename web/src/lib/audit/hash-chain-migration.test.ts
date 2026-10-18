import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read-only scan of migration 0104 (audit hash chain, R-154). Migrations are never run here;
 * this pins the properties the tamper-evidence claim depends on.
 */
const DIR = join(process.cwd(), "supabase", "migrations");
const file = readdirSync(DIR).find((f) => f.endsWith("_audit_hash_chain.sql"));
const raw = file ? readFileSync(join(DIR, file), "utf8") : "";
// Statements only: comments stripped, whitespace squashed, lower-cased.
const sql = raw.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();

describe("migration 0104 audit hash chain", () => {
  it("exists with the planned number", () => {
    expect(file).toBe("20261018000104_audit_hash_chain.sql");
  });

  it("adds prev_hash, row_hash and chain_seq to audit_log", () => {
    expect(sql).toMatch(/alter table audit_log add column if not exists prev_hash text, add column if not exists row_hash text, add column if not exists chain_seq bigint/);
  });

  it("hashes sha256 over prev_hash, a separator and the canonical text, as hex", () => {
    expect(sql).toMatch(/encode\(sha256\(convert_to\(coalesce\(p_prev, ''\) \|\| '\|' \|\| nopm_audit_canonical\(r\), 'utf8'\)\), 'hex'\)/);
  });

  it("the canonical text covers every business column and the connector provenance", () => {
    const body = sql.slice(sql.indexOf("function nopm_audit_canonical"), sql.indexOf("function nopm_audit_row_hash"));
    for (const col of [
      "r.id", "r.workspace_id", "r.actor_type", "r.actor_id", "r.actor_label", "r.principal_id", "r.action",
      "r.target_type", "r.target_id", "r.before", "r.after", "r.channel", "r.request_id", "r.created_at",
      "r.via_connector_id", "r.external_event_id", "r.external_actor_ref", "r.chain_seq",
    ]) {
      expect(body, col).toContain(col);
    }
  });

  it("a BEFORE INSERT trigger fills the chain under a per-workspace advisory lock", () => {
    expect(sql).toMatch(/create trigger trg_audit_chain before insert on audit_log for each row execute function nopm_audit_chain\(\)/);
    const fn = sql.slice(sql.indexOf("function nopm_audit_chain()"), sql.indexOf("drop trigger if exists trg_audit_chain"));
    expect(fn).toContain("pg_advisory_xact_lock(hashtext(new.workspace_id::text))");
    // The lock is taken BEFORE the previous row is read.
    expect(fn.indexOf("pg_advisory_xact_lock")).toBeLessThan(fn.indexOf("select a.row_hash"));
    expect(fn).toContain("where a.workspace_id = new.workspace_id");
    expect(fn).toMatch(/new\.prev_hash := v_prev/);
    expect(fn).toMatch(/new\.row_hash := nopm_audit_row_hash\(v_prev, new\)/);
  });

  it("backfills with the update guard off only for the backfill, then not null after it", () => {
    const off = sql.indexOf("alter table audit_log disable trigger trg_audit_no_update;");
    const on = sql.indexOf("alter table audit_log enable trigger trg_audit_no_update;");
    const update = sql.indexOf("update audit_log set chain_seq = r.chain_seq, prev_hash = r.prev_hash, row_hash = r.row_hash");
    const notNull = sql.indexOf("alter column row_hash set not null");
    expect(off).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(off);
    expect(on).toBeGreaterThan(update);
    expect(notNull).toBeGreaterThan(on);
    expect(sql.match(/disable trigger/g)).toHaveLength(1);
    expect(sql.match(/enable trigger/g)).toHaveLength(1);
    // Backfill order is created_at, id per workspace.
    expect(sql).toMatch(/order by a\.created_at, a\.id/);
  });

  it("the insert trigger is created after the backfill, so the backfill cannot re-hash itself", () => {
    expect(sql.indexOf("create trigger trg_audit_chain")).toBeGreaterThan(sql.indexOf("enable trigger trg_audit_no_update"));
  });

  it("keeps chain positions unique per workspace", () => {
    expect(sql).toMatch(/create unique index if not exists audit_log_chain_idx on audit_log \(workspace_id, chain_seq\)/);
  });

  it("defines the verify function with the planned signature and result columns", () => {
    expect(sql).toMatch(
      /function nopm_audit_verify_chain\( p_workspace_id uuid, p_from timestamptz default null, p_limit integer default 50000 \) returns table \(ok boolean, checked bigint, first_bad_id uuid, first_bad_at timestamptz, first_seq bigint\)/,
    );
  });

  it("verification is bounded: newest p_limit rows (default 50000, clamped), anchored on the stored prev_hash of the oldest checked row", () => {
    const body = sql.slice(sql.indexOf("function nopm_audit_verify_chain"));
    expect(body).toContain("least(greatest(coalesce(p_limit, 50000), 1), 1000000)");
    expect(body).toMatch(/order by a\.chain_seq desc limit v_limit/);
    expect(body).toMatch(/a\.chain_seq >= v_min_seq/);
    expect(body).toMatch(/v_prev := r\.prev_hash; v_seq := r\.chain_seq - 1;/);
  });

  it("every new function is executable by the service role only", () => {
    for (const sig of ["nopm_audit_canonical(audit_log)", "nopm_audit_row_hash(text, audit_log)", "nopm_audit_verify_chain(uuid, timestamptz, integer)"]) {
      expect(sql, sig).toContain(`revoke execute on function ${sig} from public, anon, authenticated`);
      expect(sql, sig).toContain(`grant execute on function ${sig} to service_role`);
    }
    expect(sql).not.toMatch(/grant execute on function [^;]* to (anon|authenticated|public)/);
  });

  it("never drops or replaces the immutability triggers", () => {
    expect(sql).not.toMatch(/drop trigger [a-z ]*trg_audit_no_/);
    expect(sql).not.toMatch(/create (or replace )?function nopm_audit_immutable/);
  });
});
