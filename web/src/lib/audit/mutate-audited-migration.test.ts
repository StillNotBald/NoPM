/**
 * Migration 0103 (nopm_mutate_audited) — source-text drift tests. There is no
 * live Postgres in this suite; the SQL is covered by these scans and the
 * behaviour by the wrapper and route tests over the in-memory mirror.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AUDITED_TABLES } from "./audited-write";

const dir = join(process.cwd(), "supabase", "migrations");
const strip = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const SQL = strip(readFileSync(join(dir, "20261018000103_mutate_audited.sql"), "utf8"));
const SIG = "nopm_mutate_audited(text, text, uuid, uuid, jsonb, timestamptz, jsonb)";

describe("0103 nopm_mutate_audited", () => {
  it("allowlists exactly the tables the TS wrapper names", () => {
    const seeded = [...SQL.matchAll(/insert into nopm_mutate_audited_tables[^;]*;/g)].map((m) => m[0]).join("\n");
    const names = [...seeded.matchAll(/\(\s*'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(names).toEqual([...AUDITED_TABLES].sort());
  });

  it("keeps the allowlist in a table (not in the function body) so a later migration can extend it without recreating the RPC", () => {
    expect(SQL).toMatch(/create table if not exists nopm_mutate_audited_tables/);
    expect(SQL).toMatch(/alter table nopm_mutate_audited_tables enable row level security/);
    expect(SQL).toMatch(/revoke all on nopm_mutate_audited_tables from public, anon, authenticated/);
    expect(SQL).toMatch(/from nopm_mutate_audited_tables where table_name = p_table/);
    expect(SQL).not.toMatch(/c_allowed/);
  });

  it("narrows the sensitive tables to their lifecycle columns", () => {
    const profiles = SQL.match(/\('profiles',[^)]*\)[^)]*\)/)?.[0] ?? "";
    expect(profiles).toContain("'display_name'");
    for (const bad of ["role", "workspace_id", "status"]) expect(profiles).not.toContain(`'${bad}'`);
    expect(SQL).toMatch(/\('api_tokens', null, array\['label', 'revoked', 'revoked_at', 'expires_at', 'last_used_at'\]\)/);
    expect(SQL).toMatch(/\('invites', null, array\[[^\]]*'revoked'/);
    expect(SQL).toMatch(/\('assistant_credentials', null, array\[[^\]]*'api_key_enc'/);
    expect(SQL).toContain("is not updatable here");
    expect(SQL).toContain("is not insertable here");
  });

  it("refuses an updated_at pin on a table without updated_at instead of answering STALE_ROW", () => {
    expect(SQL).toContain("NO_UPDATED_AT");
    expect(SQL.indexOf("NO_UPDATED_AT")).toBeLessThan(SQL.indexOf("STALE_ROW'"));
  });

  it("checks the table against the allowlist before reading any column metadata", () => {
    expect(SQL.indexOf("from nopm_mutate_audited_tables where table_name")).toBeLessThan(SQL.indexOf("information_schema.columns"));
    expect(SQL).toContain("TABLE_NOT_ALLOWED");
  });

  it("uses error codes no other migration uses", () => {
    const mine = ["P0051", "P0052", "P0053", "P0054", "P0055", "P0056"];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql") && !x.includes("000103_"))) {
      const t = strip(readFileSync(join(dir, f), "utf8"));
      for (const c of mine) expect(t.includes(c), `${f} reuses ${c}`).toBe(false);
    }
  });

  it("quotes identifiers with %I and never concatenates a value into SQL", () => {
    expect(SQL).toMatch(/format\([\s\S]*%1\$I/);
    expect(SQL).toContain("jsonb_populate_record");
    expect(SQL).not.toMatch(/\|\|\s*p_table/);
    expect(SQL).not.toMatch(/quote_literal/);
  });

  it("validates every patch key against information_schema.columns and refuses id / workspace_id / created_at", () => {
    expect(SQL).toMatch(/information_schema\.columns[\s\S]*table_name = p_table[\s\S]*column_name = v_key/);
    expect(SQL).toContain("UNKNOWN_COLUMN");
    expect(SQL).toMatch(/c_forbidden constant text\[\] := array\['id', 'workspace_id', 'created_at'\]/);
    expect(SQL).toContain("FORBIDDEN_COLUMN");
  });

  it("scopes every row to the workspace, maps 0 rows to NOT_FOUND and honours expected updated_at as STALE_ROW", () => {
    expect(SQL).toMatch(/t\.%I = \$1 and t\.%I = \$2 for update/);
    expect(SQL).toMatch(/jsonb_build_object\(v_ws_col, p_workspace_id\)/);
    expect(SQL).toContain("NOT_FOUND");
    expect(SQL).toMatch(/p_expected_updated_at is not null/);
    expect(SQL).toContain("STALE_ROW");
  });

  it("keys project_budget on project_id and accepts the github channel", () => {
    expect(SQL).toMatch(/('project_budget', 'project_id')/);
    expect(SQL).toContain("'lark', 'github')");
  });

  it("writes the audit row in the same function and returns before and after", () => {
    expect(SQL.match(/insert into audit_log/g)).toHaveLength(1);
    for (const col of ["principal_id", "request_id", "channel", "via_connector_id", "external_event_id", "external_actor_ref"]) {
      expect(SQL).toContain(col);
    }
    expect(SQL).toMatch(/return jsonb_build_object\('before', v_before - v_omit, 'after', v_after - v_omit\)/);
  });

  it("supports the audit overrides handlers need: omit_columns, before / after / target_id, after_extra, require_null", () => {
    for (const key of ["omit_columns", "'before'", "'after'", "target_id", "after_extra", "require_null"]) {
      expect(SQL).toContain(key);
    }
  });

  it("is a single plpgsql transaction: security definer, pinned search_path, no commit / savepoint / exception block", () => {
    expect(SQL).toMatch(/language plpgsql\s+security definer\s+set search_path = public/);
    expect(SQL).not.toMatch(/\bcommit\b|\bsavepoint\b|\bexception\s+when\b/i);
  });

  it("is executable by service_role only", () => {
    expect(SQL).toContain(`revoke execute on function ${SIG} from public, anon, authenticated`);
    expect(SQL).toContain(`grant  execute on function ${SIG} to service_role`);
  });

  it("has exactly one overload across all migrations", () => {
    const all = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const defs: string[] = [];
    for (const f of all) {
      const t = strip(readFileSync(join(dir, f), "utf8"));
      for (const m of t.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?nopm_mutate_audited\s*\(([\s\S]*?)\)\s*returns/gi)) {
        defs.push(`${f}: ${m[1].replace(/\s+/g, " ")}`);
      }
    }
    expect(defs).toHaveLength(1);
    expect(SQL).toMatch(/drop function if exists nopm_mutate_audited\(text, text, uuid, uuid, jsonb, timestamptz, jsonb\)/);
  });
});
