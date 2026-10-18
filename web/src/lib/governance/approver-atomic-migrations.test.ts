/**
 * Migrations 0061 / 0062 / 0063 — source-text drift tests (no live Postgres in
 * this suite; the behaviour is mirrored by test-support/fake-rpcs.ts and checked
 * by the route tests, the SQL itself by local-DB probes).
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

const M61 = read("20261017000061_approver_role_backstop.sql");
const M62 = read("20261017000062_rebaseline_apply_unlock_atomic.sql");
const M63 = read("20261017000063_signoff_decision_lock_atomic.sql");

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  if (start < 0) throw new Error(`${name} not defined`);
  return sql.slice(start, sql.indexOf("\n$$;", start) + 4);
}

describe("0061 — deletion approver role backstop", () => {
  it("is a trigger (survives redefinition of the commit RPCs) and does not redefine them", () => {
    expect(M61).toMatch(/create trigger trg_deletion_approver_role\s+before update on deletion_requests/);
    expect(M61).not.toMatch(/nopm_commit_(task|project)_deletion/);
  });
  it("only admin / manager principals of the same workspace may move a pending request to committed / approved / rejected", () => {
    const body = fn(M61, "nopm_deletion_approver_role");
    expect(body).toContain("role in ('admin', 'manager')");
    expect(body).toContain("new.workspace_id");
    expect(body).toMatch(/'committed', 'approved', 'rejected'/);
    expect(body).not.toContain("'withdrawn'");
    expect(body).toContain("errcode = 'P0018'");
  });
  it("is service-role only and has a pinned search_path", () => {
    expect(M61).toMatch(/revoke execute on function nopm_deletion_approver_role\(\) from public, anon, authenticated/);
    expect(M61).toMatch(/grant\s+execute on function nopm_deletion_approver_role\(\) to service_role/);
    expect(fn(M61, "nopm_deletion_approver_role")).toContain("set search_path = public");
  });
});

describe("0062 / 0063 — audit rows inside the transaction", () => {
  const cases: Array<[string, string, string[]]> = [
    ["nopm_apply_rebaseline", M62, ["'rebaseline.apply'"]],
    ["nopm_unlock_project_audited", M62, ["'project.unlock'", "'rebaseline.cancelled'"]],
    ["nopm_signoff_rebaseline", M63, ["'rebaseline.signoff'"]],
    ["nopm_decide_change_request", M63, ["'change_request.decide'"]],
    ["nopm_lock_project", M63, ["'project.lock'"]],
  ];
  for (const [name, sql, actions] of cases) {
    describe(name, () => {
      const body = fn(sql, name);
      it("is SECURITY DEFINER with a pinned search_path, guards the channel and carries full provenance", () => {
        expect(body).toContain("security definer");
        expect(body).toContain("set search_path = public");
        expect(body).toContain("INVALID_CHANNEL");
        for (const col of ["channel", "request_id", "via_connector_id", "external_event_id", "external_actor_ref"]) {
          expect(body).toContain(col);
        }
      });
      it("writes its audit action(s) itself", () => {
        for (const a of actions) expect(body).toContain(a);
        expect(body).toMatch(/insert into audit_log/);
      });
      it("is closed to anon / authenticated and open to service_role only", () => {
        expect(sql).toMatch(new RegExp(`revoke execute on function ${name}\\([^)]*\\) from public, anon, authenticated`));
        expect(sql).toMatch(new RegExp(`grant\\s+execute on function ${name}\\([^)]*\\) to service_role`));
      });
    });
  }

  it("the three decision functions check the approver principal is an admin / manager (P0018) before touching rows", () => {
    for (const [name, sql] of [
      ["nopm_apply_rebaseline", M62],
      ["nopm_signoff_rebaseline", M63],
      ["nopm_decide_change_request", M63],
    ] as const) {
      const body = fn(sql, name);
      expect(body, name).toContain("role in ('admin', 'manager')");
      expect(body.indexOf("P0018"), name).toBeGreaterThan(-1);
      expect(body.indexOf("P0018"), name).toBeLessThan(body.search(/for update/));
    }
  });

  it("D11: apply refuses when the project is no longer locked (P0019) and runs the snapshot in the same transaction", () => {
    const body = fn(M62, "nopm_apply_rebaseline");
    expect(body).toContain("errcode = 'P0019'");
    expect(body).toContain("perform nopm_apply_rebaseline_snapshot(");
    expect(body.indexOf("P0019")).toBeLessThan(body.indexOf("perform nopm_apply_rebaseline_snapshot"));
  });

  it("nothing in these migrations drops data or redefines the older RPCs", () => {
    for (const sql of [M61, M62, M63]) {
      expect(sql).not.toMatch(/\bdrop\s+(table|column|type)\b/i);
      expect(sql).not.toMatch(/create or replace function nopm_(unlock_project\(|apply_rebaseline_snapshot\(|commit_)/);
    }
  });
});
