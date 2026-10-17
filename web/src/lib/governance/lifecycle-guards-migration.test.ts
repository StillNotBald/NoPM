/**
 * Lifecycle guards — migration-text drift test (migration 0049).
 *
 * There is no live Postgres in this suite, so — same source-text approach as
 * lock-db-backstop.test.ts and principal-migration.test.ts — this reads the
 * migration off disk and asserts the contract the TypeScript layer relies on:
 * every API rule R1 found unbacked has its database twin, the SQL and the TS
 * agree on field lists / state machines / child tables, and nothing that would
 * trip the other migration drift tests (audit inserts, RPC redefinitions) is
 * smuggled in. The behaviour itself is exercised by the local-DB probes
 * (scripts/local-db), which the orchestrator runs against a disposable local
 * Supabase.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULE_SHAPE_PROJECT_FIELDS } from "./lock";
import { REBASELINE_TRANSITIONS } from "./rebaseline-lifecycle";
import { FakeDb, projectChildCounts } from "./test-support/fake-admin";

const migrationsDir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const FILE = "20261017000049_lifecycle_guards.sql";
const text = readFileSync(join(migrationsDir, FILE), "utf8");

/** SQL with `--` comments stripped, so assertions only see executable text. */
const sql = text
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

function functionSource(name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  if (start < 0) throw new Error(`${FILE} does not define ${name}`);
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end + 4);
}

function triggerStatement(name: string): string {
  const m = sql.match(new RegExp(`create trigger ${name}\\b[^;]*;`, "i"));
  if (!m) throw new Error(`${FILE} does not create trigger ${name}`);
  return m[0];
}

describe("0049 file", () => {
  it("sorts after every migration that existed when it was written (0048)", () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain(FILE);
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf("20261016000048_rls_api_only_writes.sql"));
  });

  it("does not write audit rows or redefine the deletion-commit RPCs (provenance / glossary drift tests own those)", () => {
    expect(sql).not.toMatch(/insert into audit_log/i);
    expect(sql).not.toMatch(/function nopm_commit_(task|project)_deletion/i);
  });

  it("every function it defines is closed to anon / authenticated and open to service_role", () => {
    // "p_member_id uuid, p_entry_date date" -> "uuid, date": the revoke/grant lines name argument TYPES only.
    const typesOf = (params: string) =>
      params
        .split(",")
        .map((p) => p.trim().split(/\s+/).pop())
        .filter(Boolean)
        .join(", ");
    const names = [...sql.matchAll(/create or replace function (\w+)\(([^)]*)\)/g)].map((m) => [m[1], typesOf(m[2])]);
    expect(names.length).toBe(7);
    for (const [name, args] of names) {
      expect(sql, `${name} revoke`).toMatch(new RegExp(`revoke execute on function ${name}\\(${args}\\) from public, anon, authenticated`));
      expect(sql, `${name} grant`).toMatch(new RegExp(`grant\\s+execute on function ${name}\\(${args}\\) to service_role`));
    }
  });
});

describe("H1 — projects baseline backstop", () => {
  const trigger = triggerStatement("trg_lock_backstop_projects_upd");

  it("is a BEFORE UPDATE row trigger that only fires for an already-locked project", () => {
    expect(trigger).toMatch(/before update on projects/i);
    expect(trigger).toMatch(/for each row/i);
    expect(trigger).toMatch(/old\.is_locked is true/i);
  });

  it("its WHEN clause covers every SCHEDULE_SHAPE_PROJECT_FIELDS entry (lock.ts is authoritative)", () => {
    for (const field of SCHEDULE_SHAPE_PROJECT_FIELDS) {
      expect(trigger, field).toMatch(new RegExp(`old\\.${field} is distinct from new\\.${field}`));
    }
  });

  it("raises PROJECT_LOCKED / P0010 and honours only the transaction-local rebaseline bypass", () => {
    const fn = functionSource("nopm_assert_project_baseline_unlocked");
    expect(fn).toContain("current_setting('nopm.lock_bypass', true) = 'on'");
    expect(fn).toMatch(/PROJECT_LOCKED/);
    expect(fn).toMatch(/errcode = 'P0010'/);
  });
});

describe("H2 — timesheet freeze and content binding", () => {
  it("adds the digest and reopened_at columns", () => {
    expect(sql).toMatch(/add column if not exists content_digest\s+text/i);
    expect(sql).toMatch(/add column if not exists reopened_at\s+timestamptz/i);
  });

  it("a submitted sheet freezes its week unless it was reopened; an approved one always does", () => {
    const fn = functionSource("nopm_week_lock_state");
    expect(fn).toMatch(/bool_or\(status = 'approved'\) then 'approved'/);
    expect(fn).toMatch(/bool_or\(status = 'submitted' and reopened_at is null\) then 'under_review'/);
    expect(fn).toMatch(/status in \('submitted', 'approved'\)/);
  });

  it("the week-lock trigger keeps P0011 for approved and adds P0012 for under review", () => {
    const fn = functionSource("nopm_assert_week_unlocked");
    expect(fn).toMatch(/PERIOD_LOCKED[\s\S]*errcode = 'P0011'/);
    expect(fn).toMatch(/TIMESHEET_LOCKED[\s\S]*errcode = 'P0012'/);
    // UPDATE moves a row between weeks: both must be open.
    expect(fn).toMatch(/old\.member_id, old\.entry_date/);
    expect(fn).toMatch(/new\.member_id, new\.entry_date/);
  });

  it("UPDATE of an entry is guarded, but only for content columns (a task delete nulls task_id and must pass)", () => {
    const trigger = triggerStatement("trg_period_lock_time_entries_upd");
    for (const column of ["member_id", "entry_date", "hours", "project_id", "billable"]) {
      expect(trigger, column).toMatch(new RegExp(`old\\.${column}\\s+is distinct from new\\.${column}`));
    }
    expect(trigger).not.toMatch(/task_id/);
    expect(trigger).not.toMatch(/note/);
  });

  it("approving a sheet re-checks the entries against the submitted snapshot (P0013)", () => {
    const trigger = triggerStatement("trg_timesheet_approval_binds_content");
    expect(trigger).toMatch(/before update on timesheet_submissions/i);
    expect(trigger).toMatch(/new\.status = 'approved' and old\.status is distinct from 'approved'/);
    const fn = functionSource("nopm_assert_timesheet_unchanged");
    expect(fn).toMatch(/sum\(hours\)/);
    expect(fn).toMatch(/new\.hours_total/);
    expect(fn).toMatch(/new\.entry_count/);
    expect(fn).toMatch(/errcode = 'P0013'/);
  });
});

describe("M2 — rebaseline lifecycle trigger", () => {
  const fn = functionSource("nopm_enforce_rebaseline_lifecycle");

  it("is a BEFORE UPDATE trigger that fires when the status changes", () => {
    const trigger = triggerStatement("trg_rebaseline_lifecycle");
    expect(trigger).toMatch(/before update on rebaselines/i);
    expect(trigger).toMatch(/old\.status is distinct from new\.status/);
    expect(fn).toMatch(/errcode = 'P0014'/);
  });

  it("allows exactly the transitions rebaseline-lifecycle.ts allows", () => {
    const fromSql: string[] = [];
    for (const m of fn.matchAll(/old\.status = '(\w+)'\s+and new\.status (?:in \(([^)]*)\)|= '(\w+)')/g)) {
      const targets = m[2] ? [...m[2].matchAll(/'(\w+)'/g)].map((t) => t[1]) : [m[3]];
      for (const to of targets) fromSql.push(`${m[1]}>${to}`);
    }
    const fromTs = Object.entries(REBASELINE_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`));
    expect(fromSql.sort()).toEqual(fromTs.sort());
  });
});

describe("M4 — project deletion is bound to the requested scope", () => {
  it("counts exactly the child tables the TypeScript fake (and so the route tests) assume", () => {
    const fn = functionSource("nopm_project_child_counts");
    const sqlTables = [...fn.matchAll(/'(\w+)',\s+\(select count\(\*\) from (\w+)\s+where project_id = p_project_id\)/g)];
    expect(sqlTables.length).toBeGreaterThan(0);
    for (const [, key, table] of sqlTables) expect(key).toBe(table);
    expect(sqlTables.map((m) => m[1]).sort()).toEqual(Object.keys(projectChildCounts(new FakeDb(), "p")).sort());
  });

  it("a BEFORE DELETE trigger on projects compares the live counts with the pending request's snapshot (P0016)", () => {
    const trigger = triggerStatement("trg_project_delete_scope");
    expect(trigger).toMatch(/before delete on projects/i);
    const fn = functionSource("nopm_assert_project_children_unchanged");
    expect(fn).toMatch(/dr\.before -> 'child_counts'/);
    expect(fn).toMatch(/dr\.status = 'pending'/);
    expect(fn).toMatch(/nopm_project_child_counts\(old\.id\) is distinct from v_expected/);
    expect(fn).toMatch(/errcode = 'P0016'/);
    expect(fn).toMatch(/security definer/i);
  });

  it("requests already pending are bound to the contents as of the migration", () => {
    expect(sql).toMatch(/update deletion_requests dr[\s\S]*jsonb_build_object\('child_counts', nopm_project_child_counts\(dr\.target_id\)\)/);
    expect(sql).toMatch(/dr\.status = 'pending'/);
  });
});

describe("change-request content version", () => {
  it("updated_at is bumped by a trigger on EVERY update, so it is a sound content version for the approval pin", () => {
    const base = readFileSync(join(migrationsDir, "20260608000017_change_control.sql"), "utf8");
    expect(base).toMatch(/create trigger trg_change_requests_updated before update on change_requests\s+for each row execute function nopm_set_updated_at\(\)/);
  });
});

describe("errcodes are unique to their meaning", () => {
  it("each new errcode is raised once; P0015 stays unused", () => {
    for (const code of ["P0012", "P0013", "P0014", "P0016"]) {
      expect([...sql.matchAll(new RegExp(`errcode = '${code}'`, "g"))].length, code).toBe(1);
    }
    expect(sql).not.toMatch(/P0015/);
  });
});
