/**
 * Lifecycle guards — migration-text drift test (migrations 0049 and 0054).
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
import { CHILD_COUNTS_KEY } from "./project-children";

const migrationsDir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const FILE = "20261017000049_lifecycle_guards.sql";
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
  // The state machine was extended by 0058 (cancelled): the allow-list that has
  // to agree with rebaseline-lifecycle.ts is the LATEST definition, not 0049's.
  const latestFile = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => /create or replace function nopm_enforce_rebaseline_lifecycle\(/i.test(readFileSync(join(migrationsDir, f), "utf8")))
    .pop() as string;
  const latestSql = readFileSync(join(migrationsDir, latestFile), "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  const start = latestSql.indexOf("create or replace function nopm_enforce_rebaseline_lifecycle(");
  const fn = latestSql.slice(start, latestSql.indexOf("\n$$;", start) + 4);

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
  // The child-count function itself is checked against the schema, across every
  // migration that redefines it, in "nopm_project_child_counts covers every table"
  // below — a list typed in this file would only ever agree with itself.

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

// ── M4/P1-3: the child-count function covers every table that cascades ──────
//
// 0049 counted 12 tables by hand; three more (project_budget, clashes,
// calendar_feeds) cascaded from projects unseen, and the test that was meant to
// catch it compared the SQL list with the fake's list, both typed from the same
// 12. This suite derives the truth from the schema itself: every
// `references projects ... on delete cascade` in supabase/migrations/*.sql names
// a table whose rows a project deletion destroys, and each must be counted by
// the LATEST definition of nopm_project_child_counts.

const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

/** A migration's executable text: `--` comments removed. */
function stripComments(source: string): string {
  return source
    .split(/\r?\n/) // a Windows checkout has CRLF: `.` does not match \r, so `--.*$` would miss every comment
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * Every table with a foreign key to projects that is ON DELETE CASCADE, mapped to
 * the migration that declares it. The reader tracks the nearest preceding
 * `create table X` / `alter table X`, so it also finds columns declared
 * mid-table and constraints added by a later ALTER.
 */
/** Tables that cascade from projects, as of migration `upTo` (default: all migrations). */
function tablesCascadingFromProjects(upTo?: string): Map<string, string> {
  const found = new Map<string, string>();
  const token =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?(\w+)|(references\s+(?:public\.)?projects\b[^,;]*?on\s+delete\s+cascade)/gi;
  for (const file of migrationFiles) {
    if (upTo && file > upTo) break;
    let current = "";
    for (const m of stripComments(readFileSync(join(migrationsDir, file), "utf8")).matchAll(token)) {
      if (m[1] || m[2]) current = (m[1] ?? m[2]).toLowerCase();
      else if (current) found.set(current, file);
    }
  }
  return found;
}

/** The latest migration (up to `upTo`, if given) that defines nopm_project_child_counts, with the body it left behind. */
function latestChildCountsDefinition(upTo?: string): { file: string; body: string } {
  let latest: { file: string; body: string } | null = null;
  for (const file of migrationFiles) {
    if (upTo && file > upTo) break;
    const src = stripComments(readFileSync(join(migrationsDir, file), "utf8"));
    const start = src.search(/create or replace function nopm_project_child_counts\(/i);
    if (start < 0) continue;
    latest = { file, body: src.slice(start, src.indexOf("\n$$;", start) + 4) };
  }
  if (!latest) throw new Error("no migration defines nopm_project_child_counts");
  return latest;
}

/** The `'key', (select count(*) from table ...)` pairs of a function body. */
function countedTables(body: string): { key: string; table: string }[] {
  return [...body.matchAll(/'(\w+)',\s+\(select count\(\*\) from (?:public\.)?(\w+)/gi)].map((m) => ({
    key: m[1],
    table: m[2].toLowerCase(),
  }));
}

/**
 * Tables that cascade from projects but are NOT in the deletion fingerprint, each with the reason.
 * Only derived system data belongs here: nothing a person authored or approved, and regenerated
 * by a job. Counting such a table would void every pending deletion request each time the job runs.
 */
const DERIVED_UNCOUNTED: Record<string, string> = {
  project_snapshots: "derived trend data written by the nightly snapshot cron (0098); regenerated, never authored",
};

describe("M4 — nopm_project_child_counts covers every table that cascades from projects", () => {
  const cascading = tablesCascadingFromProjects();
  const latest = latestChildCountsDefinition();
  const counted = countedTables(latest.body);

  it("the schema reader finds the cascade children (it is not vacuously empty)", () => {
    expect(cascading.size).toBeGreaterThanOrEqual(15);
    for (const known of ["milestones", "tasks", "clashes", "project_budget", "calendar_feeds", "sprints", "time_entries"]) {
      expect(cascading.has(known), known).toBe(true);
    }
  });

  it("the latest definition (0099 or later, not pinned to 0056) counts every one of them, bar the derived allowlist", () => {
    expect(latest.file >= "20261018000099_project_dependencies.sql").toBe(true);
    for (const t of Object.keys(DERIVED_UNCOUNTED)) {
      expect(cascading.has(t), `${t} is allowlisted but no longer cascades`).toBe(true);
      expect(counted.some((c) => c.table === t), `${t} is derived and must stay out of the fingerprint`).toBe(false);
    }
    const countedSet = new Set(counted.map((c) => c.table));
    const missing = [...cascading.entries()]
      .filter(([table]) => !countedSet.has(table) && !(table in DERIVED_UNCOUNTED))
      .map(([table, file]) => `${table} (${file})`);
    expect(missing, `${latest.file} must count these tables or a project deletion destroys their rows unannounced`).toEqual([]);
  });

  it("every counted table is a real table, and each result key is the table's own name", () => {
    const created = new Set<string>();
    for (const file of migrationFiles) {
      const src = stripComments(readFileSync(join(migrationsDir, file), "utf8"));
      for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/gi)) {
        created.add(m[1].toLowerCase());
      }
    }
    expect(counted.length).toBeGreaterThan(0);
    for (const { key, table } of counted) {
      expect(created.has(table), table).toBe(true);
      expect(key, table).toBe(table);
    }
  });

  it("canary: the 0049 definition alone is caught — it missed exactly the three tables 0054 adds", () => {
    const at0049 = new Set(countedTables(latestChildCountsDefinition(FILE).body).map((c) => c.table));
    const missing = [...tablesCascadingFromProjects("20261017000054_lifecycle_guards_2.sql").keys()].filter((table) => !at0049.has(table)).sort();
    expect(missing).toEqual(["calendar_feeds", "clashes", "project_budget"]);
  });

  it("the TypeScript fake counts the same tables as the latest SQL (so the route tests exercise the real contract)", () => {
    expect(Object.keys(projectChildCounts(new FakeDb(), "p")).sort()).toEqual(counted.map((c) => c.table).sort());
  });

  it("a clash is counted from EITHER project it names", () => {
    expect(latest.body).toMatch(
      /'clashes',\s+\(select count\(\*\) from clashes\s+where project_a_id = p_project_id or project_b_id = p_project_id\)/,
    );
    const db = new FakeDb({
      clashes: [
        { id: "c1", project_a_id: "p", project_b_id: "other" },
        { id: "c2", project_a_id: "other", project_b_id: "p" },
        { id: "c3", project_a_id: "other", project_b_id: "other" },
      ],
    });
    expect(projectChildCounts(db, "p").clashes).toBe(2);
  });
});

// ── 0054 ────────────────────────────────────────────────────────────────────

describe("0054 file", () => {
  const FILE_54 = "20261017000054_lifecycle_guards_2.sql";
  const sql54 = stripComments(readFileSync(join(migrationsDir, FILE_54), "utf8"));

  it("sorts after the migrations that existed when it was written (0053)", () => {
    expect(migrationFiles.indexOf(FILE_54)).toBeGreaterThan(migrationFiles.indexOf("20261017000053_hub_card_integrity.sql"));
  });

  it("redefines the count function with 0049's signature and attributes, and keeps it closed to anon / authenticated", () => {
    expect(latestChildCountsDefinition(FILE_54).file).toBe(FILE_54);
    const fn49 = latestChildCountsDefinition(FILE).body;
    const fn54 = latestChildCountsDefinition(FILE_54).body;
    for (const attr of [/returns jsonb/i, /language plpgsql/i, /\bstable\b/i, /set search_path = public/i]) {
      expect(fn49, `0049 ${attr}`).toMatch(attr);
      expect(fn54, `0054 ${attr}`).toMatch(attr);
    }
    // Only the TRIGGER that calls it is security definer; the count function is not (0049 made the same choice).
    expect(fn49).not.toMatch(/security definer/i);
    expect(fn54).not.toMatch(/security definer/i);
    expect(sql54).toMatch(/revoke execute on function nopm_project_child_counts\(uuid\) from public, anon, authenticated/);
    expect(sql54).toMatch(/grant\s+execute on function nopm_project_child_counts\(uuid\) to service_role/);
  });

  it("keeps every key 0049 had and adds project_budget, clashes and calendar_feeds", () => {
    const keys49 = countedTables(latestChildCountsDefinition(FILE).body).map((c) => c.key);
    const keys54 = countedTables(latestChildCountsDefinition(FILE_54).body).map((c) => c.key);
    expect(keys54).toEqual(expect.arrayContaining(keys49));
    expect(keys54.filter((k) => !keys49.includes(k)).sort()).toEqual(["calendar_feeds", "clashes", "project_budget"]);
  });

  it("re-snapshots the pending project deletions under the key the trigger reads, and only those", () => {
    expect(CHILD_COUNTS_KEY).toBe("child_counts");
    expect(sql54).toMatch(
      /update deletion_requests dr\s+set before = coalesce\(dr\.before, '\{\}'::jsonb\)\s+\|\|\s+jsonb_build_object\('child_counts', nopm_project_child_counts\(dr\.target_id\)\)/,
    );
    expect(sql54).toMatch(/dr\.target_type = 'project'\s+and dr\.status = 'pending'/);
    // 0049's trigger reads the very same key.
    expect(sql).toMatch(/dr\.before -> 'child_counts'/);
  });

  it("F-09: takes insert / update / delete on the nine API-only tables away from anon and authenticated", () => {
    const m = sql54.match(/revoke\s+insert,\s*update,\s*delete\s+on\s+([\w\s,]+?)\s+from\s+anon,\s*authenticated\s*;/i);
    expect(m, "0054 has no table-level revoke of insert, update, delete").not.toBeNull();
    const tables = m![1].split(",").map((t) => t.trim()).sort();
    expect(tables).toEqual(
      [
        "api_tokens",
        "assistant_conversations",
        "assistant_credentials",
        "assistant_demo_usage",
        "assistant_messages",
        "audit_log",
        "user_mfa",
        "user_preferences",
        "workspaces",
      ].sort(),
    );
    // Every one of them is a table some migration creates (a revoke on a missing table aborts the whole migration).
    const created = new Set<string>();
    for (const file of migrationFiles) {
      for (const t of stripComments(readFileSync(join(migrationsDir, file), "utf8")).matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/gi)) {
        created.add(t[1].toLowerCase());
      }
    }
    for (const table of tables) expect(created.has(table), table).toBe(true);
  });

  it("F-09: MAINTAIN is revoked from client roles (existing tables and the default ACL), only where the server knows the privilege, and nothing grants it back", () => {
    const block = sql54.match(/do\s+\$\$([\s\S]*?)\$\$\s*;/i);
    expect(block, "0054 has no do-block").not.toBeNull();
    expect(block![1]).toMatch(/server_version_num'\)::int\s*>=\s*170000/);
    expect(block![1]).toMatch(/execute\s+'revoke maintain on all tables in schema public from anon, authenticated'/);
    expect(block![1]).toMatch(/execute\s+'alter default privileges in schema public revoke maintain on tables from anon, authenticated'/);
    for (const file of migrationFiles) {
      const text = stripComments(readFileSync(join(migrationsDir, file), "utf8"));
      expect(text, file).not.toMatch(/\bgrant\b[^;]*\bmaintain\b/i);
    }
  });

  it("closes EXECUTE on nopm_recompute_project_completion to client roles without redefining it", () => {
    expect(sql54).toMatch(/revoke execute on function nopm_recompute_project_completion\(uuid\) from public, anon, authenticated/);
    expect(sql54).toMatch(/grant\s+execute on function nopm_recompute_project_completion\(uuid\) to service_role/);
    expect(sql54).not.toMatch(/create or replace function nopm_recompute_project_completion/i);
  });

  it("creates no policy, trigger, write grant or audit row (0048's lockdown and the provenance tests stay true)", () => {
    expect(sql54).not.toMatch(/create\s+(or\s+replace\s+)?(policy|trigger)/i);
    expect(sql54).not.toMatch(/drop\s+(policy|trigger)/i);
    expect(sql54).not.toMatch(/grant\s+(all|insert|update|delete|truncate)/i);
    expect(sql54).not.toMatch(/insert into audit_log/i);
    expect(sql54).not.toMatch(/function nopm_commit_(task|project)_deletion/i);
  });
});

// ── 0055 ────────────────────────────────────────────────────────────────────

describe("0055 file — the rebaseline snapshot also moves the project's own baseline", () => {
  const FILE_55 = "20261017000055_project_baseline_trail.sql";
  const FILE_28 = "20260814000028_project_lock_enforcement.sql";
  const sql55 = stripComments(readFileSync(join(migrationsDir, FILE_55), "utf8"));
  const sql28 = stripComments(readFileSync(join(migrationsDir, FILE_28), "utf8"));

  const fnOf = (src: string) => {
    const start = src.search(/create or replace function nopm_apply_rebaseline_snapshot\(/i);
    if (start < 0) throw new Error("no definition of nopm_apply_rebaseline_snapshot");
    return src.slice(start, src.indexOf("\n$$;", start) + 4);
  };
  const fn55 = fnOf(sql55);
  const fn28 = fnOf(sql28);
  const grantLines = (src: string) =>
    src
      .split("\n")
      .filter((l) => /^(revoke|grant)\s+execute on function nopm_apply_rebaseline_snapshot/i.test(l.trim()))
      .map((l) => l.replace(/\s+/g, " ").trim());

  it("sorts after the migrations that existed when it was written (0054) and is the latest definition of the function", () => {
    expect(migrationFiles.indexOf(FILE_55)).toBeGreaterThan(migrationFiles.indexOf("20261017000054_lifecycle_guards_2.sql"));
    const definers = migrationFiles.filter((f) =>
      /create or replace function nopm_apply_rebaseline_snapshot\(/i.test(stripComments(readFileSync(join(migrationsDir, f), "utf8"))),
    );
    expect(definers.slice(0, 2)).toEqual([FILE_28, FILE_55]); // 0056 redefines it again (below)
  });

  it("keeps the 0028 signature, return type and attributes, so the build that is live keeps working against it", () => {
    const head = (fn: string) =>
      fn
        .slice(0, fn.indexOf("as $$"))
        .replace(/\s+/g, " ")
        .replace(/\( /g, "(")
        .replace(/ \)/g, ")")
        .trim();
    expect(head(fn55)).toBe(head(fn28));
    expect(head(fn55)).toMatch(/\(p_project_id uuid, p_workspace_id uuid\) returns void language plpgsql set search_path = public$/);
    // 0028 never made it security definer; widening the privilege model is not this migration's business.
    expect(fn28).not.toMatch(/security definer/i);
    expect(fn55).not.toMatch(/security definer/i);
  });

  it("keeps the milestone and task snapshot exactly as 0028 wrote it, and sets the bypass first", () => {
    const body55 = fn55.replace(/\s+/g, " ");
    const body28 = fn28.replace(/\s+/g, " ");
    const children28 = body28.slice(body28.indexOf("perform set_config"), body28.indexOf(" end; $$;"));
    expect(body55).toContain(children28);
    expect(fn55).toContain("perform set_config('nopm.lock_bypass', 'on', true);");
  });

  it("updates the project's baseline columns INSIDE the bypass (after set_config, scoped to the project and workspace)", () => {
    const bypassAt = fn55.indexOf("perform set_config('nopm.lock_bypass', 'on', true)");
    const projectUpdate = fn55.search(/update projects\s+set/i);
    expect(bypassAt).toBeGreaterThan(-1);
    expect(projectUpdate).toBeGreaterThan(bypassAt);
    const stmt = fn55.slice(projectUpdate, fn55.indexOf(";", projectUpdate)).replace(/\s+/g, " ");
    expect(stmt).toMatch(/baseline_start_date = start_date/);
    expect(stmt).toMatch(/baseline_target_date = target_date/);
    expect(stmt).toMatch(/where id = p_project_id and workspace_id = p_workspace_id/);
    // Like the task snapshot: a project with no dates at all is left alone, so an apply can never wipe a baseline.
    expect(stmt).toMatch(/\(start_date is not null or target_date is not null\)/);
    // It really needs the bypass: the 0049 trigger guards exactly these columns on a locked project.
    expect(SCHEDULE_SHAPE_PROJECT_FIELDS).toEqual(expect.arrayContaining(["baseline_start_date", "baseline_target_date"]));
    // It writes the project row and nothing the 0049 trigger would not already let the bypass through.
    expect(stmt).not.toMatch(/is_locked|locked_by|lock_reason/);
  });

  it("its grants are the 0028 grants, unchanged: closed to public / anon / authenticated, open to service_role", () => {
    expect(grantLines(sql55)).toEqual(grantLines(sql28));
    expect(grantLines(sql55)).toEqual([
      "revoke execute on function nopm_apply_rebaseline_snapshot(uuid, uuid) from public, anon, authenticated;",
      "grant execute on function nopm_apply_rebaseline_snapshot(uuid, uuid) to service_role;",
    ]);
  });

  it("creates no policy, trigger, table change, write grant or audit row (0048's lockdown and the provenance tests stay true)", () => {
    expect(sql55).not.toMatch(/create\s+(or\s+replace\s+)?(policy|trigger)/i);
    expect(sql55).not.toMatch(/drop\s+(policy|trigger)/i);
    expect(sql55).not.toMatch(/alter\s+table/i);
    expect(sql55).not.toMatch(/grant\s+(all|insert|update|delete|truncate)/i);
    expect(sql55).not.toMatch(/insert into audit_log/i);
    expect(sql55).not.toMatch(/function nopm_commit_(task|project)_deletion/i);
    expect([...sql55.matchAll(/create or replace function (\w+)\(/g)].map((m) => m[1])).toEqual(["nopm_apply_rebaseline_snapshot"]);
  });
});


// ── 0056 ────────────────────────────────────────────────────────────────────

describe("0056 file — review fixes", () => {
  const FILE_56 = "20261017000056_review_fixes.sql";
  const raw56 = readFileSync(join(migrationsDir, FILE_56), "utf8");
  const sql56 = stripComments(raw56);
  const fn = (name: string) => {
    const start = sql56.search(new RegExp(`create or replace function ${name}\\(`, "i"));
    if (start < 0) throw new Error(`${FILE_56} does not define ${name}`);
    return sql56.slice(start, sql56.indexOf("\n$$;", start) + 4);
  };
  const norm = (t: string) => t.replace(/\s+/g, " ");

  it("sorts after 0055 and never edits an applied migration (it only create-or-replaces)", () => {
    expect(migrationFiles.indexOf(FILE_56)).toBeGreaterThan(migrationFiles.indexOf("20261017000055_project_baseline_trail.sql"));
    expect(sql56).not.toMatch(/\bdrop\s+(table|column|policy)/i);
    expect(sql56).not.toMatch(/\balter\s+table/i);
  });

  describe("1 — rebaseline apply never wipes a baseline date", () => {
    const body = norm(fn("nopm_apply_rebaseline_snapshot"));
    it("each baseline column coalesces its own live date with its current baseline", () => {
      expect(body).toMatch(/baseline_start_date = coalesce\(start_date, baseline_start_date\)/);
      expect(body).toMatch(/baseline_target_date = coalesce\(target_date, baseline_target_date\)/);
      expect(body.slice(body.indexOf("update projects"))).not.toMatch(/baseline_(start|target)_date = (start|target)_date\b/);
    });
    it("keeps the bypass first, the milestone/task snapshot, and the 0055 grants", () => {
      expect(body.indexOf("set_config('nopm.lock_bypass'")).toBeLessThan(body.indexOf("update projects"));
      expect(body).toContain("update milestones set baseline_target_date = target_date");
      expect(sql56).toMatch(/revoke execute on function nopm_apply_rebaseline_snapshot\(uuid, uuid\) from public, anon, authenticated/);
      expect(sql56).toMatch(/grant\s+execute on function nopm_apply_rebaseline_snapshot\(uuid, uuid\) to service_role/);
      expect(body).toMatch(/returns void language plpgsql set search_path = public/);
      expect(body).not.toMatch(/security definer/i);
    });
  });

  describe("2 — a deletion that deleted nothing is not committed (P0017 TARGET_GONE)", () => {
    for (const [name, table] of [
      ["nopm_commit_task_deletion", "tasks"],
      ["nopm_commit_project_deletion", "projects"],
    ] as const) {
      it(`${name} raises P0017 when the delete removed 0 rows, BEFORE the commit and both audit rows`, () => {
        const body = fn(name);
        const del = body.search(new RegExp(`delete from ${table} where id = r\\.target_id`));
        const diag = body.indexOf("get diagnostics v_deleted = row_count");
        const raise = body.indexOf("raise exception 'TARGET_GONE");
        const commit = body.indexOf("update deletion_requests set");
        const firstAudit = body.indexOf("insert into audit_log");
        expect(del).toBeGreaterThan(-1);
        expect(diag).toBeGreaterThan(del);
        expect(raise).toBeGreaterThan(diag);
        expect(raise).toBeLessThan(commit);
        expect(commit).toBeLessThan(firstAudit);
        expect(body).toMatch(/if v_deleted = 0 then\s+raise exception 'TARGET_GONE[^']*'\s+using errcode = 'P0017'/);
        expect(body).toMatch(/v_deleted\s+integer;/);
      });
      it(`${name} keeps the 0045 signature (12 params, principal first) and the service_role-only grants`, () => {
        const body = fn(name);
        const header = body.slice(0, body.indexOf("returns jsonb"));
        expect(header).toMatch(/p_approver_principal_id\s+uuid,/);
        expect(header).toMatch(/p_external_actor_ref\s+text default null\s*\)\s*$/i);
        const sig = "uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text";
        expect(sql56).toContain(`revoke execute on function ${name}(${sig}) from public, anon, authenticated;`);
        expect(sql56).toMatch(new RegExp(`grant\\s+execute on function ${name}\\(${sig}\\) to service_role;`));
      });
    }
    it("P0017 is raised exactly twice here and is not used by any earlier migration", () => {
      expect([...sql56.matchAll(/errcode = 'P0017'/g)].length).toBe(2);
      for (const file of migrationFiles.filter((f) => f < FILE_56)) {
        expect(readFileSync(join(migrationsDir, file), "utf8"), file).not.toMatch(/P0017/);
      }
    });
    it("the project RPC locks the project row FOR UPDATE before the cascade (count-before-lock race)", () => {
      const body = norm(fn("nopm_commit_project_deletion"));
      expect(body).toMatch(/select is_locked into v_locked from projects where id = r\.target_id and workspace_id = p_workspace_id for update;/);
      expect(body.indexOf("for update;", body.indexOf("select is_locked"))).toBeLessThan(body.indexOf("delete from projects"));
    });
  });

  describe("3 — the scope guard compares content, not only counts", () => {
    const counts = fn("nopm_project_child_counts");
    const trigger = fn("nopm_assert_project_children_unchanged");

    it("still counts every table that cascades from projects, with the same signature and attributes", () => {
      // As of 0056: later migrations (0099) redefine the function again for the tables they add.
      const cascading = tablesCascadingFromProjects(FILE_56);
      const counted = new Set(countedTables(counts).map((c) => c.table));
      expect([...cascading.keys()].filter((t) => !counted.has(t))).toEqual([]);
      expect(latestChildCountsDefinition(FILE_56).file).toBe(FILE_56);
      for (const attr of [/returns jsonb/i, /language plpgsql/i, /\bstable\b/i, /set search_path = public/i]) expect(counts).toMatch(attr);
      expect(counts).not.toMatch(/security definer/i);
      expect(sql56).toMatch(/revoke execute on function nopm_project_child_counts\(uuid\) from public, anon, authenticated/);
      expect(sql56).toMatch(/grant\s+execute on function nopm_project_child_counts\(uuid\) to service_role/);
    });

    it("adds a _scope fingerprint: the project row's own fields + a digest of each child table's sorted ids", () => {
      const body = norm(counts);
      expect(body).toMatch(/'_scope', jsonb_build_object\( 'project',/);
      // volatile roll-up columns must not void an approval
      expect(body).toMatch(/to_jsonb\(p\) - 'completion_pct' - 'rag_status' - 'updated_at'/);
      const ids = [...body.matchAll(/'(\w+)', \(select md5\(coalesce\(string_agg\((\w+)::text, ',' order by \2\), ''\)\) from (\w+) where/g)];
      const cascading = tablesCascadingFromProjects(FILE_56);
      expect(ids.map((m) => m[3]).sort()).toEqual([...cascading.keys()].sort());
      for (const m of ids) expect(m[1], "digest key is the table name").toBe(m[3]);
      // project_budget has no id column: its primary key is project_id
      expect(body).toMatch(/string_agg\(project_id::text, ',' order by project_id\), ''\)\) from project_budget/);
      // a clash digest covers either side, like its count
      expect(body).toMatch(/from clashes where project_a_id = p_project_id or project_b_id = p_project_id\)/);
    });

    it("the trigger locks the project row BEFORE it counts, then compares the whole snapshot (or counts only for a legacy one)", () => {
      const body = norm(trigger);
      expect(body.indexOf("for update")).toBeGreaterThan(-1);
      expect(body.indexOf("for update")).toBeLessThan(body.indexOf("nopm_project_child_counts(old.id)"));
      expect(body).toMatch(/perform 1 from projects where id = old\.id for update;/);
      expect(body).toMatch(/if not \(v_expected \? '_scope'\) then v_current := v_current - '_scope'; end if;/);
      expect(body).toMatch(/if v_current is distinct from v_expected then raise exception 'CHILDREN_CHANGED/);
      expect(body).toMatch(/errcode = 'P0016'/);
      expect(trigger).toMatch(/security definer/i);
      expect(sql56).toMatch(/revoke execute on function nopm_assert_project_children_unchanged\(\) from public, anon, authenticated/);
      expect(sql56).toMatch(/grant\s+execute on function nopm_assert_project_children_unchanged\(\) to service_role/);
    });

    it("recreates the BEFORE DELETE trigger idempotently", () => {
      expect(sql56).toMatch(
        /drop trigger if exists trg_project_delete_scope on projects;\s+create trigger trg_project_delete_scope\s+before delete on projects\s+for each row execute function nopm_assert_project_children_unchanged\(\);/,
      );
    });

    it("re-snapshots every pending project deletion so none is stranded count-only", () => {
      expect(norm(sql56)).toMatch(
        /update deletion_requests dr set before = coalesce\(dr\.before, '\{\}'::jsonb\) \|\| jsonb_build_object\('child_counts', nopm_project_child_counts\(dr\.target_id\)\) where dr\.target_type = 'project' and dr\.status = 'pending';/,
      );
      expect(CHILD_COUNTS_KEY).toBe("child_counts");
    });
  });

  describe("4 — plain index under the set-null FK", () => {
    it("indexes integration_deliveries(parent_delivery_id) without a predicate, idempotently", () => {
      expect(norm(sql56)).toMatch(/create index if not exists \w+ on integration_deliveries \(parent_delivery_id\);/);
    });
    it("the FK is still ON DELETE SET NULL and the only other index on the column is partial (so this one is needed)", () => {
      const hub = stripComments(readFileSync(join(migrationsDir, "20261016000046_integration_hub.sql"), "utf8"));
      expect(hub).toMatch(/parent_delivery_id\s+uuid references integration_deliveries\(id\) on delete set null/);
      expect(hub).toMatch(/on integration_deliveries\(parent_delivery_id\) where kind = 'decision_update'/);
    });
  });

  it("adds no policy or write grant, and no audit insert beyond the two per commit RPC that 0045 had", () => {
    expect(sql56).not.toMatch(/create\s+(or\s+replace\s+)?policy/i);
    expect(sql56).not.toMatch(/grant\s+(all|insert|update|delete|truncate)/i);
    expect([...sql56.matchAll(/insert into audit_log/g)].length).toBe(4);
  });
});
