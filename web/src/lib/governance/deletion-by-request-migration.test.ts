/**
 * Migration-text test for 0102 (deletion by request for every governed record, audit gap G8).
 * No live Postgres in this suite, so the SQL text is asserted, like governed-children-migration.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const m = readFileSync(join(dir, "20261018000102_deletion_by_request_all.sql"), "utf8");
const m76 = readFileSync(join(dir, "20261017000076_governance_flow_answers.sql"), "utf8");

const ENTITIES = [
  { e: "risk", t: "risks" },
  { e: "issue", t: "issues" },
  { e: "expense", t: "expenses" },
  { e: "document", t: "documents" },
  { e: "milestone", t: "milestones" },
];

/** The text of one function: from its create statement to the revoke that follows it. */
function fn(text: string, name: string): string {
  const start = text.indexOf(`create or replace function ${name}(`);
  expect(start, `${name} is created`).toBeGreaterThan(-1);
  const end = text.indexOf(`revoke execute on function ${name}`, start);
  expect(end, `${name} is revoked from public`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("0102 target_type CHECK", () => {
  it("allows exactly the seven types, added NOT VALID then validated without blocking the deploy", () => {
    expect(m).toMatch(
      /add constraint deletion_requests_target_type_check\s+check \(target_type in \('task', 'project', 'risk', 'issue', 'expense', 'document', 'milestone'\)\) not valid/,
    );
    expect(m).toContain("validate constraint deletion_requests_target_type_check");
    expect(m).toContain("exception when check_violation");
  });

  it("widens the chat hub's approval_kind checks to the five new kinds", () => {
    for (const table of ["integration_deliveries", "action_tokens"]) {
      expect(m).toContain(`alter table ${table} drop constraint if exists ${table}_approval_kind_check`);
      expect(m).toContain(`validate constraint ${table}_approval_kind_check`);
    }
    for (const { e } of ENTITIES) expect(m).toContain(`'${e}_deletion'`);
    // The kinds that already existed stay.
    for (const k of ["task_deletion", "project_deletion", "change_request", "timesheet", "rebaseline_signoff"]) {
      expect(m).toContain(`'${k}'`);
    }
  });
});

describe("0102 commit RPCs: one per type, one transaction, literal action strings", () => {
  it.each(ENTITIES)("nopm_commit_$e_deletion checks the tier role with the 0100 helper and message, P0018, before deleting", ({ e, t }) => {
    const body = fn(m, `nopm_commit_${e}_deletion`);
    expect(body).toContain("nopm_principal_meets_tier(p_workspace_id, r.tier, p_approver_principal_id)");
    expect(body).toContain("ROLE_NOT_PERMITTED: only %s can approve a % request");
    expect(body).toContain("nopm_tier_required_role(p_workspace_id, r.tier), r.tier using errcode = 'P0018'");
    expect(body.indexOf("nopm_principal_meets_tier")).toBeLessThan(body.indexOf(`delete from ${t}`));
  });

  it.each(ENTITIES)("nopm_commit_$e_deletion", ({ e, t }) => {
    const body = fn(m, `nopm_commit_${e}_deletion`);
    // Same signature and guards as the task RPC (0056).
    expect(body).toMatch(/p_approver_principal_id uuid,/);
    for (const guard of ["INVALID_CHANNEL", "NO_PRINCIPAL", "NOT_FOUND", "ALREADY_DECIDED", "SELF_APPROVAL", "TARGET_GONE"]) {
      expect(body).toContain(guard);
    }
    expect(body).toContain("for update");
    expect(body).toContain("set search_path = public");
    // Its own table, its own literal action, plus the governance row, in the same body.
    expect(body).toContain(`delete from ${t} where id = r.target_id and workspace_id = p_workspace_id`);
    expect(body).toContain(`'${e}.delete', r.target_type`);
    expect(body).toContain("'deletion_request.approved'");
    expect((body.match(/insert into audit_log/g) ?? []).length).toBe(2);
    // The backstop is opened for this transaction only, before the delete.
    expect(body).toContain("perform set_config('nopm.deletion_commit', 'on', true)");
    expect(body.indexOf("set_config('nopm.deletion_commit'")).toBeLessThan(body.indexOf(`delete from ${t}`));
    // Only this type's request can be committed by this function.
    expect(body).toContain(`target_type = '${e}'`);
    // service_role only.
    expect(m).toMatch(new RegExp(`revoke execute on function nopm_commit_${e}_deletion\\([^)]*\\) from public, anon, authenticated`));
    expect(m).toMatch(new RegExp(`grant\\s+execute on function nopm_commit_${e}_deletion\\([^)]*\\) to service_role`));
  });

  it("never builds the table or action name at run time (no format / execute)", () => {
    for (const { e } of ENTITIES) {
      const body = fn(m, `nopm_commit_${e}_deletion`);
      expect(body).not.toMatch(/\bexecute\b|format\(/);
    }
  });

  it("each action string appears only in its own function", () => {
    for (const { e } of ENTITIES) {
      for (const other of ENTITIES.filter((o) => o.e !== e)) {
        expect(fn(m, `nopm_commit_${e}_deletion`)).not.toContain(`'${other.e}.delete'`);
      }
    }
  });

  it("milestone: refuses a locked project (P0010) and changed task counts (P0016)", () => {
    const body = fn(m, "nopm_commit_milestone_deletion");
    expect(body).toContain("PROJECT_LOCKED");
    expect(body).toContain("P0010");
    expect(body).toContain("CHILDREN_CHANGED");
    expect(body).toContain("P0016");
    expect(body).toContain("child_counts' ->> 'tasks'");
    expect(body.indexOf("PROJECT_LOCKED")).toBeLessThan(body.indexOf("delete from milestones"));
  });

  it("document: an approved document needs an admin requester (P0041) and an admin approver (P0042), and the file path is returned", () => {
    const body = fn(m, "nopm_commit_document_deletion");
    expect(body).toContain("v_status = 'approved'");
    expect(body).toContain("v_role is distinct from 'admin'");
    expect(body).toContain("APPROVED_DOCUMENT_NEEDS_ADMIN");
    expect(body).toContain("P0041");
    expect(body).toContain("APPROVED_DOCUMENT_APPROVER_NOT_ADMIN");
    expect(body).toContain("P0042");
    expect(body.indexOf("P0042")).toBeLessThan(body.indexOf("delete from documents"));
    expect(body).toContain("'document_path', v_path");
    expect(body.indexOf("APPROVED_DOCUMENT_NEEDS_ADMIN")).toBeLessThan(body.indexOf("delete from documents"));
  });

  it("risk, issue and expense have no extra rule (their record is the whole scope)", () => {
    for (const e of ["risk", "issue", "expense"]) {
      const body = fn(m, `nopm_commit_${e}_deletion`);
      expect(body).not.toContain("PROJECT_LOCKED");
      expect(body).not.toContain("CHILDREN_CHANGED");
    }
  });
});

describe("0102 DB backstop: no direct delete", () => {
  it("raises DELETE_NEEDS_REQUEST (P0040) unless the transaction-local setting is on", () => {
    const body = fn(m, "nopm_refuse_direct_delete");
    expect(body).toContain("current_setting('nopm.deletion_commit', true) = 'on'");
    expect(body).toContain("DELETE_NEEDS_REQUEST");
    expect(body).toContain("P0040");
    expect(body).toContain("returns trigger");
  });

  it.each(ENTITIES)("a before-delete row trigger on $t", ({ t }) => {
    expect(m).toMatch(
      new RegExp(`create trigger trg_${t}_delete_needs_request\\s+before delete on ${t}\\s+for each row execute function nopm_refuse_direct_delete\\(\\)`),
    );
    expect(m).toContain(`drop trigger if exists trg_${t}_delete_needs_request on ${t}`);
  });

  it("the setting is only ever set inside the commit RPCs (never session-wide)", () => {
    const sets = [...m.matchAll(/set_config\('nopm\.deletion_commit', 'on', (\w+)\)/g)];
    expect(sets.length).toBe(6); // five entity RPCs + the project RPC
    for (const s of sets) expect(s[1]).toBe("true"); // true = local to the transaction
  });

  it("does not touch RLS, grants on the tables, or updated_at", () => {
    expect(m).not.toMatch(/alter table \w+ (enable|disable) row level security/i);
    expect(m).not.toMatch(/create policy/i);
    expect(m).not.toMatch(/updated_at\s*=/);
  });
});

describe("0102 project RPC recreated for the cascade", () => {
  const body = fn(m, "nopm_commit_project_deletion");

  it("reads the cascade first, deletes, and only then writes audit rows (the audit advisory lock goes last, W4-12)", () => {
    const del = body.indexOf("delete from projects where id = r.target_id");
    const firstAudit = body.indexOf("insert into audit_log");
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(firstAudit);
    for (const v of ["v_cr", "v_dec", "v_doc", "v_sig", "v_rb"]) {
      expect(body.indexOf("into " + v + " ")).toBeLessThan(del);
    }
    for (const act of ["change_request", "decision", "document", "rebaseline_signoff", "rebaseline"]) {
      expect(body.indexOf("'" + act + ".cascade_delete'")).toBeGreaterThan(del);
    }
  });

  it("records counts and ids of the removed tasks, milestones, risks, issues and expenses on the project.delete row (W4-11)", () => {
    for (const t of ["tasks", "milestones", "risks", "issues", "expenses"]) expect(body).toContain("'" + t + "',");
    expect(body).toContain("'project.delete', r.target_type, r.target_id, r.before, jsonb_build_object('cascade_deleted', v_cascade)");
    expect(body.indexOf("v_cascade := ")).toBeLessThan(body.indexOf("delete from projects where id = r.target_id"));
  });

  it("closes the pending child deletion requests with the project, one audit row each (W4-28)", () => {
    expect(body).toContain("closed_reason = 'parent_deleted'");
    expect(body).toContain("target_id = any (v_child_ids)");
    expect(body).toContain("'deletion_request.withdrawn'");
    for (const t of ["task", "risk", "issue", "expense", "document", "milestone"]) expect(body).toContain("'" + t + "'");
    expect(body.indexOf("closed_reason")).toBeGreaterThan(body.indexOf("delete from projects where id = r.target_id"));
  });

  it("is created once (one overload) and the stale overloads are dropped", () => {
    expect((m.match(/create or replace function nopm_commit_project_deletion\(/g) ?? []).length).toBe(1);
    expect(m).toContain("drop function if exists nopm_commit_project_deletion(uuid, uuid, text, uuid, text, text, text)");
    expect(m).toContain("drop function if exists nopm_commit_project_deletion(uuid, uuid, text, uuid, text)");
  });

  it("checks the tier role (P0018, 0100 message) before the lock check and the delete", () => {
    expect(body).toContain("nopm_principal_meets_tier(p_workspace_id, r.tier, p_approver_principal_id)");
    expect(body).toContain("ROLE_NOT_PERMITTED: only %s can approve a % request");
    expect(body.indexOf("nopm_principal_meets_tier")).toBeLessThan(body.indexOf("delete from projects where id = r.target_id"));
  });

  it("keeps the 0076 guards, decision 20 and the document paths", () => {
    for (const guard of ["PROJECT_LOCKED", "PROJECT_HAS_APPROVED_RECORDS", "TARGET_GONE", "document_paths"]) {
      expect(body).toContain(guard);
    }
  });

  it("opens the backstop right before the cascading delete", () => {
    const set = body.indexOf("set_config('nopm.deletion_commit'");
    const del = body.indexOf("delete from projects where id = r.target_id");
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(del);
    expect(set).toBeGreaterThan(body.indexOf("into v_child_ids"));
  });

  it("keeps the service_role-only grants", () => {
    expect(m).toMatch(/revoke execute on function nopm_commit_project_deletion\([^)]*\) from public, anon, authenticated/);
    expect(m).toMatch(/grant\s+execute on function nopm_commit_project_deletion\([^)]*\) to service_role/);
  });
});

describe("0102 SQLSTATEs (W4-10)", () => {
  it("owns P0040, P0041 and P0042 and uses none of the codes 0100 and 0101 took", () => {
    expect(m).toContain("P0040");
    for (const code of ["P0030", "P0031"]) {
      const uses = m.split("\n").filter((l) => l.includes(code) && !l.startsWith("--"));
      expect(uses, code).toEqual([]);
    }
  });
});
