/**
 * Implemented stamp, decision link, structured impact - migration-text drift test
 * (migrations 0092 + 0093, audit gaps M2 + B1 + B2).
 *
 * No live Postgres in this suite, so, like lock-integrity-migration.test.ts, this
 * reads the migrations off disk and asserts the contract the TypeScript layer
 * relies on: the columns, the two CHECKs (NOT VALID first, then validated in a
 * skip-on-failure block), the single-transaction RPC with its audit insert, and
 * that no updated_at trigger is left disabled.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const m92 = readFileSync(join(dir, "20261018000092_change_request_implemented.sql"), "utf8");
const m93 = readFileSync(join(dir, "20261018000093_decision_change_request_link.sql"), "utf8");
const fn = m92.slice(m92.indexOf("create or replace function nopm_implement_change_request("));

describe("0092 change request implemented stamp (M2)", () => {
  it("adds the stamp columns and the structured impact column additively", () => {
    for (const col of [
      "implemented_at",
      "implemented_by",
      "implemented_by_type",
      "implemented_by_id",
      "implemented_by_label",
      "implemented_principal_id",
      "implemented_note",
      "impact_scope",
    ]) {
      expect(m92).toMatch(new RegExp(String.raw`add column if not exists ${col}\b`, "i"));
    }
    expect(m92).toMatch(/implemented_by_type\s+actor_type/);
    expect(m92).toMatch(/impact_scope\s+jsonb/);
  });

  it("CHECK cr_implemented_after_decision: not earlier than the decision, NOT VALID then validated", () => {
    const check = m92.match(/add constraint cr_implemented_after_decision\s+check \(([\s\S]*?)\)\s+not valid/i);
    expect(check, "cr_implemented_after_decision NOT VALID").toBeTruthy();
    expect(check![1]).toMatch(/implemented_at is null/);
    expect(check![1]).toMatch(/decided_at is not null/);
    expect(check![1]).toMatch(/implemented_at >= decided_at/);
    expect(m92.indexOf("validate constraint cr_implemented_after_decision")).toBeGreaterThan(m92.indexOf("not valid"));
  });

  it("CHECK cr_implemented_status_stamp: status implemented implies implemented_at, NOT VALID then validated", () => {
    const check = m92.match(/add constraint cr_implemented_status_stamp\s+check \(([\s\S]*?)\)\s+not valid/i);
    expect(check, "cr_implemented_status_stamp NOT VALID").toBeTruthy();
    expect(check![1]).toMatch(/status <> 'implemented' or implemented_at is not null/);
    expect(m92.indexOf("validate constraint cr_implemented_status_stamp")).toBeGreaterThan(m92.indexOf("not valid"));
    // validation can never block a release
    expect(m92).toMatch(/exception when others then/i);
    expect(m92).toMatch(/left NOT VALID/);
  });

  it("impact_scope must be a JSON array", () => {
    expect(m92).toMatch(/cr_impact_scope_array[\s\S]*?jsonb_typeof\(impact_scope\) = 'array'/);
  });

  it("the RPC is one transaction: row lock, status move, stamp and the change_request.implement audit row", () => {
    expect(fn).toMatch(/for update/i);
    expect(fn).toMatch(/status\s+= 'implemented'/);
    for (const col of [
      "implemented_at           = now()",
      "implemented_by_type      = p_actor_type::actor_type",
      "implemented_by_id        = p_actor_id",
      "implemented_by_label     = p_actor_label",
      "implemented_principal_id = p_principal_id",
    ]) {
      expect(fn).toContain(col);
    }
    expect(fn).toMatch(/implemented_by\s+= case when p_actor_type = 'user' then p_actor_id else null end/);
    expect(fn).toMatch(/insert into audit_log \([^)]*principal_id\)/);
    expect(fn).toContain("'change_request.implement'");
    expect(fn).toMatch(/to_jsonb\(cr\), to_jsonb\(v_after\)/);
    // the update and the audit insert are in the same function body, so the same transaction
    expect(fn.indexOf("update change_requests")).toBeLessThan(fn.indexOf("insert into audit_log"));
    expect(fn.match(/insert into audit_log/g)).toHaveLength(1);
  });

  it("the RPC keeps the same connector provenance arguments as the decision RPC", () => {
    for (const arg of [
      "p_channel",
      "p_correlation_id",
      "p_via_connector_id",
      "p_external_event_id",
      "p_external_actor_ref",
    ]) {
      expect(fn).toContain(arg);
    }
    expect(fn).toMatch(/not in \('ui', 'api', 'cli', 'mcp', 'assistant', 'lark'\)/);
  });

  it("guards: principal, who (requester or manager/admin), then state; approved only; repeat refused", () => {
    expect(fn).toMatch(/errcode = 'P0006'/); // no principal
    expect(fn).toMatch(/errcode = 'P0002'/); // not found
    expect(fn).toMatch(/v_role in \('admin', 'manager'\)/);
    expect(fn).toMatch(/cr\.requested_principal_id = p_principal_id/);
    expect(fn).toMatch(/errcode = 'P0023'/); // not requester
    expect(fn).toMatch(/cr\.status = 'implemented'[\s\S]*?errcode = 'P0028'/);
    expect(fn).toMatch(/cr\.status <> 'approved'[\s\S]*?errcode = 'P0024'/);
    // who is checked before the state (a stranger learns nothing about the status)
    expect(fn.indexOf("P0023")).toBeLessThan(fn.indexOf("P0028"));
    expect(fn.indexOf("P0028")).toBeLessThan(fn.indexOf("P0024"));
  });

  it("real clauses: one function, workspace-scoped role lookup, who-may before the status compare-and-set, audit inside", () => {
    expect(m92.match(/create or replace function nopm_implement_change_request\(/g)).toHaveLength(1);
    expect(fn).toMatch(/select role::text into v_role from profiles\s+where id = p_principal_id and workspace_id = p_workspace_id/);
    expect(fn).toMatch(/\(v_role is not null and v_role in \('admin', 'manager'\)\)\s+or \(cr\.requested_principal_id is not null and cr\.requested_principal_id = p_principal_id\)/);
    expect(fn).not.toMatch(/requested_by is not null/); // a NULL requester principal is approver-only
    expect(fn).toMatch(/NOT_ALLOWED/);
    expect(fn.indexOf("NOT_ALLOWED")).toBeLessThan(fn.indexOf("cr.status = 'implemented'"));
    expect(fn.indexOf("NOT_ALLOWED")).toBeLessThan(fn.indexOf("update change_requests"));
    expect(fn.indexOf("update change_requests")).toBeLessThan(fn.indexOf("insert into audit_log"));
    expect(m92).toContain("check (implemented_at is null or (decided_at is not null and implemented_at >= decided_at))");
    expect(m92).toContain("check (status <> 'implemented' or implemented_at is not null)");
  });

  it("is security definer with a pinned search_path and granted to service_role only", () => {
    expect(fn).toMatch(/security definer/);
    expect(fn).toMatch(/set search_path = public/);
    expect(m92).toMatch(/revoke execute on function nopm_implement_change_request\([^)]*\) from public, anon, authenticated;/);
    expect(m92).toMatch(/grant\s+execute on function nopm_implement_change_request\([^)]*\) to service_role;/);
  });

  it("does not backfill, so it never pauses (or leaves disabled) the updated_at trigger", () => {
    expect(m92).not.toMatch(/disable trigger/i);
    expect(m92).not.toMatch(/\bupdate change_requests set\b[\s\S]{0,40}where\s+implemented/i);
  });
});

describe("0093 decision to change request link and structured options (B1)", () => {
  it("adds the link with ON DELETE SET NULL, an index, and the structured options column", () => {
    expect(m93).toMatch(/add column if not exists change_request_id\s+uuid references change_requests\(id\) on delete set null/i);
    expect(m93).toMatch(/add column if not exists options_structured\s+jsonb/i);
    expect(m93).toMatch(/create index if not exists idx_decisions_change_request on decisions\(change_request_id\)/i);
  });

  it("options_structured must be an array; the free-text options column is untouched", () => {
    expect(m93).toMatch(/decisions_options_structured_array[\s\S]*?jsonb_typeof\(options_structured\) = 'array'/);
    expect(m93).not.toMatch(/drop column\s+options\b/i);
    expect(m93).not.toMatch(/alter column options\b/i);
  });

  it("does not backfill or touch any trigger", () => {
    expect(m93).not.toMatch(/disable trigger/i);
    expect(m93).not.toMatch(/^\s*update decisions\b/im);
  });
});
