import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Text checks on migrations 0076 / 0077 (the SQL itself is covered by the local-DB
 * probes): the redefined functions keep every 0072 guard, and the new rules are
 * where the common-pattern answers say they are.
 */
const DIR = join(process.cwd(), "supabase", "migrations");
const m76 = readFileSync(join(DIR, "20261017000076_governance_flow_answers.sql"), "utf8").replace(/\r\n/g, "\n");
const m77 = readFileSync(join(DIR, "20261017000077_cancel_orphan_draft_rebaselines.sql"), "utf8").replace(/\r\n/g, "\n");
const m72 = readFileSync(join(DIR, "20261017000072_audit_principal_in_rpcs.sql"), "utf8").replace(/\r\n/g, "\n");

function body(text: string, fn: string): string {
  const start = text.indexOf(`create or replace function ${fn}(`);
  expect(start, `${fn} defined`).toBeGreaterThan(-1);
  const end = text.indexOf("\n$$;", start);
  return text.slice(start, end);
}

describe("0076 — nopm_commit_project_deletion", () => {
  const b = body(m76, "nopm_commit_project_deletion");
  const old = body(m72, "nopm_commit_project_deletion");

  it("keeps every guard of the 0072 body (errcodes and cascade audit rows)", () => {
    for (const code of ["P0005", "P0006", "P0002", "P0001", "P0003", "P0010", "P0017"]) expect(b).toContain(code);
    for (const action of ["change_request.cascade_delete", "decision.cascade_delete", "document.cascade_delete", "rebaseline.cascade_delete", "project.delete", "deletion_request.approved"]) {
      expect(b).toContain(action);
    }
    // the audit-insert count is unchanged
    expect(b.match(/insert into audit_log/g)?.length).toBe(old.match(/insert into audit_log/g)?.length);
  });

  it("refuses (P0022) while approved change requests or approved / applied rebaselines exist", () => {
    expect(b).toContain("PROJECT_HAS_APPROVED_RECORDS");
    expect(b).toContain("P0022");
    expect(b).toMatch(/status in \('approved', 'implemented'\)/);
    expect(b).toMatch(/status::text in \('approved', 'applied'\)/);
    // checked after the project row lock and before the cascade audit rows / delete
    expect(b.indexOf("P0022")).toBeGreaterThan(b.indexOf("for update"));
    expect(b.indexOf("P0022")).toBeLessThan(b.indexOf("change_request.cascade_delete"));
  });

  it("returns the document storage paths, read before the delete", () => {
    expect(b).toContain("'document_paths', v_doc_paths");
    expect(b.indexOf("v_doc_paths")).toBeLessThan(b.indexOf("delete from projects"));
  });

  it("keeps the grants", () => {
    expect(m76).toMatch(/revoke execute on function nopm_commit_project_deletion\([^)]*\) from public, anon, authenticated/);
    expect(m76).toMatch(/grant\s+execute on function nopm_commit_project_deletion\([^)]*\) to service_role/);
  });
});

describe("0076 — nopm_lock_project is idempotent", () => {
  const b = body(m76, "nopm_lock_project");
  it("returns an already locked project untouched, before any snapshot or audit write", () => {
    expect(b).toContain("already_locked");
    expect(b.indexOf("if v_before.is_locked then")).toBeLessThan(b.indexOf("update milestones"));
    expect(b.indexOf("already_locked")).toBeLessThan(b.indexOf("insert into audit_log"));
  });
  it("keeps the 0072 audit insert", () => {
    expect(b).toContain("'project.lock'");
    expect(b).toContain("nopm_audit_principal");
  });
});

describe("0076 — the new functions audit in the same transaction", () => {
  it("nopm_transition_change_request: start_review needs manager/admin, reopen needs requester or manager/admin", () => {
    const b = body(m76, "nopm_transition_change_request");
    expect(b).toContain("'change_request.start_review'");
    expect(b).toContain("'change_request.reopen'");
    expect(b).toContain("P0018");
    expect(b).toContain("P0023");
    expect(b).toContain("P0024");
    expect(b).toMatch(/cr\.status <> 'raised'/);
    expect(b).toMatch(/cr\.status <> 'deferred'/);
    expect(b).toMatch(/decided_principal_id = null/);
    expect(b.match(/insert into audit_log/g)).toHaveLength(1);
  });
  it("nopm_withdraw_rebaseline: proposer only, pending_approval only, one audit row", () => {
    const b = body(m76, "nopm_withdraw_rebaseline");
    expect(b).toContain("'rebaseline.withdrawn'");
    expect(b).toContain("P0023");
    expect(b).toMatch(/r\.status::text <> 'pending_approval'/);
    expect(b).toMatch(/set status = 'cancelled'/);
    expect(b.match(/insert into audit_log/g)).toHaveLength(1);
  });
  it("both are service-role only", () => {
    for (const fn of ["nopm_transition_change_request", "nopm_withdraw_rebaseline"]) {
      expect(m76).toMatch(new RegExp(`revoke execute on function ${fn}\\([^)]*\\) from public, anon, authenticated`));
      expect(m76).toMatch(new RegExp(`grant\\s+execute on function ${fn}\\([^)]*\\) to service_role`));
    }
  });
});

describe("0076 — additive column", () => {
  it("adds deletion_requests.closed_reason nullable and idempotently", () => {
    expect(m76).toMatch(/alter table deletion_requests add column if not exists closed_reason text;/);
  });
});

describe("0077 — orphan draft rebaselines", () => {
  it("cancels only drafts, audits each, and restores the lifecycle trigger", () => {
    expect(m77).toMatch(/disable trigger trg_rebaseline_lifecycle/);
    expect(m77).toMatch(/enable trigger trg_rebaseline_lifecycle/);
    expect(m77.indexOf("disable trigger")).toBeLessThan(m77.indexOf("enable trigger"));
    expect(m77).toMatch(/where status::text = 'draft'/);
    expect(m77).toContain("'rebaseline.cancelled'");
    expect(m77).toContain("orphan_draft_cleanup");
  });
});
