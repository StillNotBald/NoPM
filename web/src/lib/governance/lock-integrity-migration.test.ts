/**
 * Lock integrity - migration-text drift test (migration 0088, audit gaps M7 + K3).
 *
 * No live Postgres in this suite, so, like principal-migration.test.ts, this reads
 * the migration off disk and asserts the contract the TypeScript layer relies on:
 * the actor columns exist, the CHECK exists (NOT VALID first, then validated after
 * the backfill), the lock RPC always sets the actor columns, no second overload of
 * the lock RPC is left callable, and unlock clears the locker.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "20261018000088_lock_integrity.sql";
const text = readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", FILE), "utf8");
const lockFn = text.slice(text.indexOf("create or replace function nopm_lock_project("));

describe("0088 lock integrity", () => {
  it("adds the three actor columns additively", () => {
    for (const col of ["locked_by_actor_type", "locked_by_actor_id", "locked_by_label"]) {
      expect(text).toMatch(new RegExp(String.raw`add column if not exists ${col}\b`, "i"));
    }
    expect(text).toMatch(/locked_by_actor_type in \('user', 'token'\)/);
  });

  it("adds the integrity CHECK NOT VALID, then validates it after the backfill", () => {
    const check = text.match(/add constraint projects_lock_integrity check \(([\s\S]*?)\) not valid/i);
    expect(check, "projects_lock_integrity CHECK NOT VALID").toBeTruthy();
    expect(check![1]).toMatch(/is_locked = false/);
    expect(check![1]).toMatch(/locked_at is not null/);
    expect(check![1]).toMatch(/locked_by_actor_id is not null/);
    const validate = text.indexOf("validate constraint projects_lock_integrity");
    expect(validate).toBeGreaterThan(text.indexOf("not valid"));
    expect(validate).toBeGreaterThan(text.indexOf("get diagnostics v_legacy"));
    expect(text).toMatch(/exception when others then/i); // validation can never block a release
  });

  it("backfills from the latest project.lock audit row and reports the count", () => {
    expect(text).toMatch(/distinct on \(a\.target_id\)/);
    expect(text).toMatch(/a\.action = 'project\.lock'/);
    expect(text).toMatch(/a\.principal_id/);
    expect(text).toMatch(/raise notice '0088 lock_integrity/);
    expect(text).toMatch(/legacy lock \(locker not recorded\)/);
  });

  it("the lock RPC sets the actor columns and keeps a token's principal in locked_by", () => {
    expect(lockFn).toMatch(/locked_by = case when p_actor_type = 'user' then p_actor_id else v_principal end/);
    expect(lockFn).toMatch(/locked_by_actor_type = p_actor_type/);
    expect(lockFn).toMatch(/locked_by_actor_id\s+= p_actor_id/);
    expect(lockFn).toMatch(/locked_by_label\s+= v_label/);
    expect(lockFn).toMatch(/v_principal := nopm_audit_principal\(/);
    expect(lockFn).not.toMatch(/else null end/); // the K3 root cause is gone
  });

  it("leaves no second overload of the lock RPC callable and keeps the grants tight", () => {
    expect(text).toMatch(/proname = 'nopm_lock_project'/);
    // The loop must EXCLUDE the recreated 11-argument signature (else it would drop it).
    const loop = text.match(/for r in([\s\S]*?)loop/)?.[1] ?? "";
    expect(loop).toMatch(/pg_get_function_identity_arguments\(p\.oid\) <>/);
    expect(loop).toContain(
      "p_project_id uuid, p_workspace_id uuid, p_reason text, p_actor_type text, p_actor_id uuid, p_actor_label text, p_channel text, p_correlation_id text, p_via_connector_id uuid, p_external_event_id text, p_external_actor_ref text",
    );
    expect(text.indexOf("execute 'drop function '")).toBeLessThan(text.indexOf("create or replace function nopm_lock_project("));
    expect(text).toMatch(/execute 'drop function ' \|\| r\.sig/);
    expect(text).toMatch(/revoke execute on function nopm_lock_project\(.*\) from public, anon, authenticated;/);
    expect(text).toMatch(/grant\s+execute on function nopm_lock_project\(.*\) to service_role;/);
  });

  it("unlock clears the locker through a trigger, whichever RPC unlocks", () => {
    expect(text).toMatch(/create trigger trg_projects_lock_actor_clear\s+before update on projects/);
    expect(text).toMatch(/if new\.is_locked is not true then/);
    for (const col of ["locked_by_actor_type", "locked_by_actor_id", "locked_by_label"]) {
      expect(text).toMatch(new RegExp(String.raw`new\.${col}\s*:= null`));
    }
  });

  it("never touches audit_log rows (immutability)", () => {
    expect(text).not.toMatch(/(update|delete from|truncate)\s+audit_log/i);
  });
});
