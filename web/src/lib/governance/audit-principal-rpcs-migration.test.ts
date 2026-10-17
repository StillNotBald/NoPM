/**
 * Migrations 0072 / 0073 — source-text drift tests. 0072 must be the previous
 * body of each function with only the audit inserts changed; 0073 the timesheet
 * approver backstop.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const strip = (t: string) =>
  t
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
const read = (f: string) => strip(readFileSync(join(dir, f), "utf8"));

const M72 = read("20261017000072_audit_principal_in_rpcs.sql");
const M73 = read("20261017000073_timesheet_approver_role_backstop.sql");

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  if (start < 0) throw new Error(`${name} not defined`);
  return sql.slice(start, sql.indexOf("\n$$;", start) + 4);
}

const SOURCES: Array<[string, string, string]> = [
  ["nopm_apply_rebaseline", "20261017000062_rebaseline_apply_unlock_atomic.sql", "p_approver_principal_id"],
  ["nopm_unlock_project_audited", "20261017000062_rebaseline_apply_unlock_atomic.sql", "nopm_audit_principal("],
  ["nopm_signoff_rebaseline", "20261017000063_signoff_decision_lock_atomic.sql", "p_approver_principal_id"],
  ["nopm_decide_change_request", "20261017000063_signoff_decision_lock_atomic.sql", "p_approver_principal_id"],
  ["nopm_lock_project", "20261017000063_signoff_decision_lock_atomic.sql", "nopm_audit_principal("],
  ["nopm_commit_project_deletion", "20261017000064_governed_children_audit_and_refs.sql", "p_approver_principal_id"],
  ["nopm_revoke_connector", "20261017000069_connector_revoke_atomic.sql", "nopm_audit_principal("],
];

// Undo the principal_id additions so the new body can be compared with the old one.
const normalise = (b: string) =>
  b
    .replace(/, principal_id\)/g, ")")
    .replace(/, p_approver_principal_id(\)?;?|\n)/g, "$1")
    .replace(/, nopm_audit_principal\(p_workspace_id, p_actor_type, p_actor_id\)\);/g, ");")
    .replace(/\s+/g, " ");

describe("0072 — principal_id on every SQL-written audit row (R-2)", () => {
  for (const [name, file, expr] of SOURCES) {
    describe(name, () => {
      const prev = read(file);
      const prevBody = fn(prev, name);
      const body = fn(M72, name);

      it("keeps every guard, error code, security attribute and search_path of the previous body", () => {
        for (const m of prevBody.match(/raise exception '[^']+'[^;]*;/g) ?? []) {
          expect(body).toContain(m);
        }
        for (const kw of ["security definer", "set search_path = public", "for update", "language plpgsql"]) {
          expect(body.includes(kw)).toBe(prevBody.includes(kw));
        }
        expect(body.match(/errcode = 'P\d+'/g)).toEqual(prevBody.match(/errcode = 'P\d+'/g));
      });

      it("every audit insert sets principal_id and nothing else changed", () => {
        const inserts = (body.match(/insert into audit_log/g) ?? []).length;
        expect(inserts).toBe((prevBody.match(/insert into audit_log/g) ?? []).length);
        expect((body.match(/, principal_id\)/g) ?? []).length).toBe(inserts);
        expect(body).toContain(expr);
        expect(normalise(body)).toBe(normalise(prevBody));
      });

      it("keeps the revoke / grant to service_role only", () => {
        const grants = (prev.slice(prev.indexOf(prevBody)).match(/(revoke|grant)\s+execute on function[^;]+;/g) ?? []).filter(
          (g) => g.includes(`${name}(`),
        );
        expect(grants.length).toBe(2);
        for (const g of grants) expect(M72).toContain(g);
      });
    });
  }

  it("nopm_audit_principal resolves a token's creator and is service-role only", () => {
    expect(M72).toContain("t.created_by from api_tokens t where t.id = p_actor_id and t.workspace_id = p_workspace_id");
    expect(M72).toMatch(/revoke execute on function nopm_audit_principal\(uuid, text, uuid\) from public, anon, authenticated;/);
    expect(M72).toMatch(/grant\s+execute on function nopm_audit_principal\(uuid, text, uuid\) to service_role;/);
  });
});

describe("0073 — timesheet approver role backstop (R-9)", () => {
  const body = fn(M73, "nopm_timesheet_approver_role");
  it("only fires on submitted -> approved/rejected and requires an admin or manager principal of the workspace", () => {
    expect(body).toContain("old.status::text = 'submitted'");
    expect(body).toContain("new.status::text in ('approved', 'rejected')");
    expect(body).toContain("role in ('admin', 'manager')");
    expect(body).toContain("workspace_id = new.workspace_id");
    expect(body).toContain("errcode = 'P0018'");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = public");
  });
  it("is a BEFORE UPDATE trigger (submit and reopen untouched) with service-role-only grants", () => {
    expect(M73).toMatch(/create trigger trg_timesheet_approver_role\s+before update on timesheet_submissions/);
    expect(M73).not.toMatch(/before insert/);
    expect(M73).toMatch(/revoke execute on function nopm_timesheet_approver_role\(\) from public, anon, authenticated;/);
  });
});
