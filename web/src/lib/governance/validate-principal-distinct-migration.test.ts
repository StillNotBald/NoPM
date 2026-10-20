/**
 * Validate principal-distinct CHECKs - migration-text drift test (migration 0115).
 * 0045 added cr_principal_distinct / deletion_principal_distinct NOT VALID; 0089 validates them best-effort and
 * swallows failures. 0115 first records past self-approvals (audit row, then the requester principal is
 * left unrecorded as in 0089), then validates them for good: re-runnable and loud.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261020000115_validate_principal_distinct.sql"),
  "utf8",
);
const code = sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");

describe("0115 validate principal-distinct", () => {
  it("covers both constraints on their tables", () => {
    expect(code).toContain("'change_requests'");
    expect(code).toContain("'cr_principal_distinct'");
    expect(code).toContain("'deletion_requests'");
    expect(code).toContain("'deletion_principal_distinct'");
  });
  it("is re-runnable: skips a constraint that is already validated", () => {
    expect(code).toMatch(/not convalidated/);
    expect(code).toMatch(/continue;/);
  });
  it("fails loudly with a count instead of swallowing the error", () => {
    expect(code).toMatch(/raise exception '0115: cannot validate/);
    expect(code).not.toMatch(/exception when others/i);
  });
  it("validates with VALIDATE CONSTRAINT and drops nothing", () => {
    expect(code).toMatch(/validate constraint/);
    expect(code).not.toMatch(/\bdrop\b|\bdelete\b|\btruncate\b/i);
  });
  it("records legacy self-approvals before validating, keeping the original value in an audit row", () => {
    const record = code.indexOf("four_eyes.legacy_self_approval_recorded");
    const validate = code.indexOf("validate constraint");
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(validate);
    expect(code).toMatch(/perform nopm_audit_insert\(/);
    expect(code).toMatch(/'requested_principal_id', r\.requested_principal_id/);
    expect(code).toMatch(/update change_requests set requested_principal_id = null where id = r\.id/);
    expect(code).toMatch(/update deletion_requests set requested_principal_id = null where id = r\.id/);
  });
  it("writes the audit row before nulling, as the system actor, and only touches the requester principal", () => {
    const audit = code.indexOf("perform nopm_audit_insert(");
    const nulling = code.indexOf("update change_requests set requested_principal_id = null");
    expect(audit).toBeLessThan(nulling);
    expect(code).toMatch(/'actor_label', 'system:migration-0115'/);
    expect(code).not.toMatch(/set\s+decided_principal_id|set\s+approved_principal_id|set\s+status/i);
  });
  it("pauses only the updated_at trigger and turns it back on", () => {
    expect(code).toMatch(/alter table change_requests disable trigger trg_change_requests_updated;/);
    expect(code).toMatch(/alter table change_requests enable trigger trg_change_requests_updated;/);
  });
  it("names the new action in the audit glossary", () => {
    const glossary = readFileSync(join(process.cwd(), "src", "lib", "audit", "action-glossary.ts"), "utf8");
    expect(glossary).toContain('"four_eyes.legacy_self_approval_recorded"');
  });
});
