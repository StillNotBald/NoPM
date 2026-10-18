/**
 * Migration 0058 (unlock voids rebaselines) — source-text drift test.
 *
 * No live Postgres in this suite, so — same approach as
 * lifecycle-guards-migration.test.ts — the migration is read off disk and the
 * contract the TypeScript layer relies on is asserted: the new enum value, the
 * widened state machine (agreeing with rebaseline-lifecycle.ts), and the atomic
 * unlock function with the same grant posture as the other RPCs. The behaviour
 * is exercised by the local-DB probes, which the orchestrator runs against a
 * disposable local Supabase.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REBASELINE_TRANSITIONS } from "./rebaseline-lifecycle";

const migrationsDir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const FILE = "20261017000058_unlock_voids_rebaselines.sql";
const text = readFileSync(join(migrationsDir, FILE), "utf8");

/** SQL with `--` comments stripped, so assertions only see executable text. */
const sql = text
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

function functionSource(name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  if (start < 0) throw new Error(`${FILE} does not define ${name}`);
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end + 4);
}

describe("0058 file", () => {
  it("sorts after 0057 and is the newest migration", () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain(FILE);
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf("20261017000057_rebaseline_signoff_atomic.sql"));
  });

  it("is idempotent: the enum value is added only if missing, functions are create-or-replace", () => {
    expect(sql).toMatch(/alter type rebaseline_status add value if not exists 'cancelled'/i);
    expect(sql).not.toMatch(/create function/i);
    expect(sql).not.toMatch(/\bdrop\s+(table|column|type)\b/i);
  });

  it("does not use the new enum value in a statement that runs in the migration's own transaction", () => {
    // Postgres refuses to use an enum value in the transaction that added it:
    // 'cancelled' may appear only inside plpgsql function bodies (resolved at run time).
    const outsideFunctions = sql.replace(/create or replace function[\s\S]*?\n\$\$;/g, "");
    expect(outsideFunctions.replace(/alter type rebaseline_status add value if not exists 'cancelled';/i, "")).not.toMatch(/'cancelled'/);
  });

  it("does not write audit rows (the route writes them) or touch the other RPCs", () => {
    expect(sql).not.toMatch(/insert into audit_log/i);
    expect(sql).not.toMatch(/nopm_apply_rebaseline_snapshot|nopm_commit_/i);
  });

  it("every function it defines is closed to anon / authenticated and open to service_role only", () => {
    const names = [...sql.matchAll(/create or replace function (\w+)\(([^)]*)\)/g)].map((m) => [
      m[1],
      m[2]
        .split(",")
        .map((p) => p.trim().split(/\s+/)[1])
        .filter(Boolean)
        .join(", "),
    ]);
    expect(names.map((n) => n[0]).sort()).toEqual(["nopm_enforce_rebaseline_lifecycle", "nopm_unlock_project"]);
    for (const [name, args] of names) {
      expect(sql, `${name} revoke`).toMatch(new RegExp(`revoke execute on function ${name}\\(${args}\\) from public, anon, authenticated`));
      expect(sql, `${name} grant`).toMatch(new RegExp(`grant\\s+execute on function ${name}\\(${args}\\) to service_role`));
    }
  });
});

describe("0058 state machine", () => {
  const fn = functionSource("nopm_enforce_rebaseline_lifecycle");

  it("allows exactly the transitions rebaseline-lifecycle.ts allows (incl. open -> cancelled, cancelled terminal)", () => {
    const fromSql: string[] = [];
    for (const m of fn.matchAll(/old\.status = '(\w+)'\s+and new\.status (?:in \(([^)]*)\)|= '(\w+)')/g)) {
      const targets = m[2] ? [...m[2].matchAll(/'(\w+)'/g)].map((t) => t[1]) : [m[3]];
      for (const to of targets) fromSql.push(`${m[1]}>${to}`);
    }
    const fromTs = Object.entries(REBASELINE_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`));
    expect(fromSql.sort()).toEqual(fromTs.sort());
    expect(fromSql).toContain("pending_approval>cancelled");
    expect(fromSql).toContain("approved>cancelled");
    expect(fromSql.filter((t) => t.startsWith("cancelled>"))).toEqual([]);
  });

  it("keeps the 0049 error contract (P0014) and signature", () => {
    expect(fn).toMatch(/errcode = 'P0014'/);
    expect(fn).toMatch(/returns trigger/i);
  });
});

describe("nopm_unlock_project", () => {
  const fn = functionSource("nopm_unlock_project");

  it("is SECURITY DEFINER with a pinned search_path and takes (project, workspace)", () => {
    expect(fn).toMatch(/nopm_unlock_project\(p_project_id uuid, p_workspace_id uuid\)/);
    expect(fn).toMatch(/security definer/i);
    expect(fn).toMatch(/set search_path = public/i);
    expect(fn).toMatch(/returns jsonb/i);
  });

  it("cancels only pending_approval and approved rebaselines of THIS project in THIS workspace", () => {
    expect(fn).toMatch(/project_id\s*=\s*p_project_id/);
    expect(fn).toMatch(/workspace_id\s*=\s*p_workspace_id/);
    expect(fn).toMatch(/status in \('pending_approval', 'approved'\)/);
    expect(fn).toMatch(/set status = 'cancelled'/);
    expect(fn).not.toMatch(/'(draft|applied|rejected)'/);
  });

  it("cancels BEFORE it unlocks, in the one function (one transaction)", () => {
    const cancel = fn.indexOf("set status = 'cancelled'");
    const unlock = fn.indexOf("is_locked = false");
    expect(cancel).toBeGreaterThan(0);
    expect(unlock).toBeGreaterThan(cancel);
    expect(fn).toMatch(/lock_reason = null/);
    expect(fn).toMatch(/locked_by = null/);
    expect(fn).toMatch(/locked_at = null/);
  });

  it("locks the project row and refuses an unknown project (P0002)", () => {
    expect(fn).toMatch(/from projects where id = p_project_id and workspace_id = p_workspace_id for update/);
    expect(fn).toMatch(/errcode = 'P0002'/);
  });

  it("returns { project, cancelled[{id, version, previous_status}] } for the route's audit rows", () => {
    expect(fn).toMatch(/jsonb_build_object\('project', to_jsonb\(v_project\), 'cancelled', v_cancelled\)/);
    expect(fn).toMatch(/'previous_status'/);
  });
});
