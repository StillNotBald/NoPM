import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Migration 0110 (wave 5, W5-C, R-165): the four unattended writers audit in one transaction.
 * Read-only text checks of the SQL file, plus parity between the RPC names and argument names
 * the TypeScript callers use and the function signatures in the migration.
 */

const root = resolve(__dirname, "../../..");
const sql = readFileSync(resolve(root, "supabase/migrations/20261018000110_atomic_jobs.sql"), "utf8");
const src = (rel: string) => readFileSync(resolve(root, "src", rel), "utf8");

/** The text of one create-or-replace function, from its header to the closing `$$;`. */
function body(name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", sql.indexOf("as $$", start));
  return sql.slice(start, end + 3);
}

/** The parameter names of a function, in declaration order. */
function params(name: string): string[] {
  const text = body(name);
  const open = text.indexOf("(");
  const close = text.indexOf(") returns");
  return text
    .slice(open + 1, close)
    .split(",")
    .map((p) => p.trim().split(/\s+/)[0])
    .filter(Boolean);
}

const FUNCTIONS = ["nopm_clash_auto_resolve", "nopm_overspend_cross", "nopm_snapshot_run", "nopm_weekly_report_store"] as const;

describe("migration 0110 atomic jobs: shape", () => {
  it("is additive and idempotent: only create-or-replace functions, no table is touched", () => {
    expect(sql.match(/create or replace function /g)).toHaveLength(4);
    expect(sql).not.toMatch(/^\s*(create|alter|drop)\s+(table|index|trigger|policy)\b/im);
    expect(sql).not.toMatch(/^\s*(delete\s+from|truncate)\b/im);
    // nothing runs at apply time: outside the function bodies there is no statement that touches rows
    const outside = sql
      .replace(/\$\$[\s\S]*?\$\$/g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(outside).not.toMatch(/\b(insert into|update|delete from)\b/i);
  });

  it("states a rollback and the apply order at the top", () => {
    const head = sql.slice(0, sql.indexOf("create or replace function"));
    expect(head).toMatch(/ROLLBACK\./);
    for (const fn of FUNCTIONS) expect(head).toContain(`drop function ${fn}(`);
    expect(head).toMatch(/ORDER OF APPLY\. After 0107/);
  });

  it.each(FUNCTIONS)("%s is security definer, pins the search_path and is service-role only", (fn) => {
    const text = body(fn);
    expect(text).toMatch(/security definer/);
    expect(text).toMatch(/set search_path = public/);
    expect(sql).toMatch(new RegExp(`revoke execute on function ${fn}\\([^)]*\\) from public, anon, authenticated;`));
    expect(sql).toMatch(new RegExp(`grant\\s+execute on function ${fn}\\([^)]*\\) to service_role;`));
    expect(sql).not.toMatch(new RegExp(`grant\\s+execute on function ${fn}\\([^)]*\\) to (anon|authenticated|public)`));
  });

  it.each(FUNCTIONS)("%s writes its audit row through the shared helper, never its own insert", (fn) => {
    const text = body(fn);
    expect(text).toContain("nopm_audit_insert(");
    expect(text).not.toMatch(/insert into audit_log/i);
    expect(text).not.toMatch(/\bprev_hash|row_hash|chain_seq\b/);
  });

  it.each(FUNCTIONS)("%s takes the workspace as its first parameter", (fn) => {
    expect(params(fn)[0]).toBe("p_workspace_id");
  });
});

describe("migration 0110: workspace filtering", () => {
  it("auto-resolve, overspend and snapshots filter every statement by the workspace", () => {
    const resolveSql = body("nopm_clash_auto_resolve");
    expect(resolveSql.match(/workspace_id = p_workspace_id/g)?.length).toBeGreaterThanOrEqual(3);
    const overspend = body("nopm_overspend_cross");
    expect(overspend).toMatch(/workspace_id = p_workspace_id/);
    const snap = body("nopm_snapshot_run");
    expect(snap).toMatch(/p\.workspace_id = p_workspace_id/); // foreign projects are dropped
    expect(snap).toMatch(/select p_workspace_id, s\.project_id, p_taken_at/); // workspace and day come from the parameters
  });

  it("the weekly report accepts only recipients that belong to the workspace", () => {
    const text = body("nopm_weekly_report_store");
    expect(text.match(/pr\.workspace_id = p_workspace_id/g)).toHaveLength(2); // scheduled and manual branches
    expect(text).toMatch(/n\.workspace_id = p_workspace_id/);
  });
});

describe("migration 0110: behaviour pinned in the text", () => {
  it("clash resolve locks the live row and writes nothing when it is no longer live", () => {
    const text = body("nopm_clash_auto_resolve");
    expect(text).toMatch(/status in \('open', 'investigating'\)\s+for update/);
    expect(text).toMatch(/if v_before is null then\s+return null;/);
    expect(text.indexOf("return null;")).toBeLessThan(text.indexOf("nopm_audit_insert("));
  });

  it("overspend compares-and-sets on the previous (non-null) level and audits only when the marker moved", () => {
    const text = body("nopm_overspend_cross");
    expect(text).toMatch(/and overspend_level = p_previous;/);
    expect(text).toMatch(/if v_rows = 0 then\s+return false;/);
    expect(text).toMatch(/jsonb_build_object\('level', p_previous\)/); // before shape
    expect(text.indexOf("return false;", text.indexOf("v_rows = 0"))).toBeLessThan(text.indexOf("nopm_audit_insert("));
  });

  it("snapshots insert on conflict do nothing and write ONE audit row per call, not per project", () => {
    const text = body("nopm_snapshot_run");
    expect(text).toMatch(/on conflict \(project_id, taken_at\) do nothing/);
    expect(text.match(/nopm_audit_insert\(/g)).toHaveLength(1);
    expect(text).toMatch(/'taken_at', p_taken_at, 'projects', v_total, 'taken', v_taken, 'already_taken'/);
  });

  it("the weekly report claims before it stores, returns already_sent without writing, and a manual run claims nothing", () => {
    const text = body("nopm_weekly_report_store");
    const claim = text.indexOf("insert into nudge_log");
    const store = text.indexOf("insert into weekly_reports");
    const audit = text.indexOf("perform nopm_audit_insert(");
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(store);
    expect(store).toBeLessThan(audit);
    expect(text).toMatch(/on conflict do nothing/); // a lost race skips the row, never raises
    expect(text).toMatch(/'already_sent'/);
    expect(text.indexOf("'already_sent'")).toBeLessThan(store);
    expect(text).toMatch(/if p_trigger = 'scheduled' then/);
    expect(text).toMatch(/else\s+-- A manual run takes no claim/);
    expect(text).toMatch(/on conflict \(workspace_id, week_start\)\s+do update set/);
  });

  it("uses new error codes that do not collide with the governance or security migrations", () => {
    const codes = [...sql.matchAll(/errcode = '(P\d{4})'/g)].map((m) => m[1]);
    expect(new Set(codes)).toEqual(new Set(["P0070", "P0071"]));
    for (const other of ["20261018000108_atomic_governance.sql", "20261018000109_atomic_security.sql"]) {
      const text = readFileSync(resolve(root, "supabase/migrations", other), "utf8");
      for (const code of codes) expect(text, `${other} must not use ${code}`).not.toContain(`errcode = '${code}'`);
    }
  });
});

describe("TypeScript callers match the migration", () => {
  /** The argument names a caller passes to one rpc call. */
  function callArgs(file: string, fn: string): string[] {
    const text = src(file);
    const at = text.indexOf(`rpc("${fn}", {`);
    expect(at, `${file} calls ${fn}`).toBeGreaterThan(-1);
    const open = text.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const inner = text.slice(open + 1, end);
    return [...inner.matchAll(/^\s{6,8}(p_[a-z_]+)\s*[:,]/gm)].map((m) => m[1]);
  }

  it.each([
    ["lib/clash/detect.ts", "nopm_clash_auto_resolve"],
    ["lib/insight/overspend.ts", "nopm_overspend_cross"],
    ["lib/insight/snapshots.ts", "nopm_snapshot_run"],
    ["lib/nudges/weekly-report.ts", "nopm_weekly_report_store"],
  ])("%s passes exactly the parameters of %s", (file, fn) => {
    expect(callArgs(file, fn).sort()).toEqual([...params(fn)].sort());
  });

  it("clash create and update use the generic wrapper on clashes, which is allowlisted", () => {
    const text = src("lib/clash/detect.ts");
    expect(text).toMatch(/auditedInsert\(\{\s+table: "clashes"/);
    expect(text).toMatch(/auditedUpdate\(\{\s+table: "clashes"/);
    expect(text).not.toMatch(/writeAudit/);
    expect(readFileSync(resolve(root, "supabase/migrations/20261018000103_mutate_audited.sql"), "utf8")).toContain("('clashes')");
  });

  it("none of the four libraries writes an audit row of its own any more", () => {
    for (const file of ["lib/clash/detect.ts", "lib/insight/overspend.ts", "lib/insight/snapshots.ts", "lib/nudges/weekly-report.ts"]) {
      expect(src(file), file).not.toMatch(/writeAudit\(/);
    }
  });

  it("the unattended rows use the system actor, the clash and overspend rows the caller", () => {
    expect(src("lib/insight/snapshots.ts")).toMatch(/systemActor\(workspaceId, "snapshots"/);
    expect(src("lib/nudges/weekly-report.ts")).toMatch(/systemActor\(workspaceId, "weekly-report"/);
    expect(src("lib/clash/detect.ts")).toMatch(/buildRpcAudit\(actor, "clash\.auto_resolve"/);
    expect(src("lib/insight/overspend.ts")).toMatch(/buildRpcAudit\(actor, OVERSPEND_AUDIT_ACTION/);
  });
});
