/**
 * Migration-text test for 0113 and 0114 (deletion by request for programs, sprints, resources, allocations and
 * clashes, wave 5 W5-G, R-176). No live Postgres in this suite, so the SQL text is asserted, like
 * deletion-by-request-migration.test.ts. The local-database probe (scripts/local-db/probe-deletion-registers.mjs)
 * runs the same rules for real before and after 0114.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const read = (name: string) => readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n");
const m113 = read("20261018000113_deletion_by_request_registers.sql");
const m114 = read("20261018000114_deletion_refuse_triggers.sql");

const REGISTERS = [
  { e: "program", t: "programs" },
  { e: "sprint", t: "sprints" },
  { e: "resource", t: "resource_members" },
  { e: "allocation", t: "allocations" },
  { e: "clash", t: "clashes" },
];
const FIVE_TABLES = REGISTERS.map((r) => r.t);

/** The text of one function: from its create statement to the revoke that follows it. */
function fn(text: string, name: string): string {
  const start = text.indexOf(`create or replace function ${name}(`);
  expect(start, `${name} is created`).toBeGreaterThan(-1);
  const end = text.indexOf(`revoke execute on function ${name}`, start);
  expect(end, `${name} is revoked from public`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("0113 header and safety", () => {
  it("is pre-deploy, additive, and says how to roll it back and in which order to apply it", () => {
    expect(m113.split("\n").slice(0, 3).join("\n")).toMatch(/PRE-DEPLOY/);
    expect(m113).toMatch(/-- ROLLBACK/);
    expect(m113).toMatch(/-- ORDER OF APPLY\. After 0112, BEFORE the build\. Then deploy\. Then 0114\./);
    expect(m113).toMatch(/BEHAVIOUR ON EXISTING ROWS/);
  });

  it("contains no trigger on any of the five tables (that is 0114, applied after the deploy, PR-19)", () => {
    expect(m113).not.toMatch(/create trigger/i);
    expect(m113).not.toContain("nopm_refuse_direct_delete()\n");
    for (const t of FIVE_TABLES) expect(m113).not.toMatch(new RegExp(`before delete on ${t}\\b`, "i"));
  });

  it("does not delete or rewrite any row of the register tables", () => {
    for (const t of FIVE_TABLES) expect(m113).not.toMatch(new RegExp(`(^|\\n)\\s*(update|insert into) ${t}\\b`, "i"));
    // The only deletes are inside the commit functions, each one keyed by the request's target.
    const deletes = m113.match(/\n\s*delete from \w+/g) ?? [];
    expect(deletes.map((d) => d.trim())).toEqual([
      "delete from programs",
      "delete from sprints",
      "delete from resource_members",
      "delete from allocations",
      "delete from clashes",
      "delete from projects", // the project commit is re-created here (W2-09 sweep)
      "delete from tasks",
    ]);
  });
});

describe("0113 target_type CHECK", () => {
  it("allows the seven old types plus the five registers, added NOT VALID, validated, and RAISES when it cannot", () => {
    expect(m113).toMatch(
      /check \(target_type in \('task', 'project', 'risk', 'issue', 'expense', 'document', 'milestone',\s+'program', 'sprint', 'resource', 'allocation', 'clash'\)\) not valid/,
    );
    expect(m113).toContain("validate constraint deletion_requests_target_type_check");
    const block = m113.slice(m113.indexOf("validate constraint deletion_requests_target_type_check"));
    expect(block).toMatch(/exception when check_violation then\s+raise exception '0113:/);
    expect(m113).not.toMatch(/raise notice/);
  });
});

describe("0113 entity map", () => {
  it("adds the five entities with their table, commit RPC and child counts", () => {
    for (const { e, t } of REGISTERS) {
      expect(m113).toMatch(new RegExp(`\\('${e}',\\s+'${t}',\\s+'nopm_commit_${e}_deletion'`));
    }
    expect(m113).toContain("on conflict (entity) do update");
    // What approving also touches, shown to the approver.
    expect(m113).toContain("from projects where workspace_id = $1 and program_id = $2");
    expect(m113).toContain("from tasks where workspace_id = $1 and sprint_id = $2");
    expect(m113).toContain("from allocations where workspace_id = $1 and member_id = $2");
    expect(m113).toContain("'allocation_ids'");
    expect(m113).toContain("from tasks where workspace_id = $1 and assignee_id = $2");
  });
});

describe("0113 commit RPCs", () => {
  for (const { e, t } of REGISTERS) {
    describe(`nopm_commit_${e}_deletion`, () => {
      const body = fn(m113, `nopm_commit_${e}_deletion`);

      it("has the 12-argument signature, locks the request, and filters by its target type", () => {
        expect(body).toMatch(/p_request_id\s+uuid,[\s\S]*p_external_actor_ref\s+text default null\s*\) returns jsonb/);
        expect(body).toContain(`target_type = '${e}'`);
        expect(body).toMatch(/for update;/);
      });

      it("keeps the guards and error codes of the other deletion commits", () => {
        for (const code of ["P0005", "P0006", "P0002", "P0001", "P0003", "P0018", "P0017"]) expect(body).toContain(code);
        expect(body).toContain("nopm_principal_meets_tier");
      });

      it("sets nopm.deletion_commit BEFORE it deletes, and the delete is workspace-filtered", () => {
        const flag = body.indexOf("set_config('nopm.deletion_commit', 'on', true)");
        const del = body.indexOf(`delete from ${t} where id = r.target_id and workspace_id = p_workspace_id`);
        expect(flag).toBeGreaterThan(-1);
        expect(del).toBeGreaterThan(flag);
      });

      it("audits with a literal action and writes the deletion_request.approved row, in the same transaction", () => {
        expect(body).toContain(`'${e}.delete', r.target_type, r.target_id, r.before,`);
        expect(body).toContain("'deletion_request.approved'");
        // the delete row and the approval row; the resource commit also audits each closed allocation request (W2-09)
        expect(body.match(/insert into audit_log/g)).toHaveLength(e === "resource" ? 3 : 2);
      });

      it("is executable by service_role only", () => {
        expect(m113).toMatch(
          new RegExp(`revoke execute on function nopm_commit_${e}_deletion\\([^)]*\\) from public, anon, authenticated;\\s+grant\\s+execute on function nopm_commit_${e}_deletion\\([^)]*\\) to service_role;`),
        );
      });
    });
  }

  it("program: the program row is locked and the project count shown at request time must still hold (P0016)", () => {
    const body = fn(m113, "nopm_commit_program_deletion");
    expect(body).toContain("from programs where id = r.target_id and workspace_id = p_workspace_id for update");
    expect(body).toContain("from projects where program_id = r.target_id");
    expect(body).toMatch(/child_counts' ->> 'projects'/);
    expect(body).toContain("P0016");
  });

  it("sprint: only a planned sprint (P0063), and the attached-task count must still hold (P0016)", () => {
    const body = fn(m113, "nopm_commit_sprint_deletion");
    expect(body).toContain("v_state <> 'planned'");
    expect(body).toContain("P0063");
    expect(body).toContain("from tasks where sprint_id = r.target_id");
    expect(body).toContain("P0016");
  });

  it("resource: repeats the timesheet refusal (P0062), checks the allocation count, and audits the cascaded allocation ids (PR-21)", () => {
    const body = fn(m113, "nopm_commit_resource_deletion");
    expect(body).toContain("from timesheet_submissions where member_id = r.target_id");
    expect(body).toContain("P0062");
    expect(body).toContain("from allocations a where a.member_id = r.target_id");
    expect(body).toMatch(/child_counts' ->> 'allocations'/);
    expect(body).toContain("'cascade_deleted', jsonb_build_object('allocations', jsonb_build_object('count', v_n, 'ids', v_ids))");
    // The allocation ids are read BEFORE the delete cascades them away.
    expect(body.indexOf("jsonb_agg(a.id")).toBeLessThan(body.indexOf("delete from resource_members"));
  });

  it("the new error codes are not used by any other migration", () => {
    const others = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && !f.includes("20261018000113"))
      .map((f) => read(f));
    for (const code of ["P0062", "P0063"]) {
      expect(others.some((t) => t.includes(code)), `${code} is free`).toBe(false);
    }
  });
});

describe("0113 makes every cascading commit RPC set nopm.deletion_commit (PR-01)", () => {
  it("redefines nopm_commit_task_deletion with the flag set before the delete cascades allocations", () => {
    const body = fn(m113, "nopm_commit_task_deletion");
    const flag = body.indexOf("set_config('nopm.deletion_commit', 'on', true)");
    const del = body.indexOf("delete from tasks where id = r.target_id and workspace_id = p_workspace_id");
    expect(flag).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(flag);
  });

  it("keeps the rest of the task commit as 0056 had it (same guards, same audit rows)", () => {
    let body = fn(m113, "nopm_commit_task_deletion");
    // Remove the three additions of 0113: the flag (with its comment), the allocation-id read, and the request sweep.
    body = body.replace(/\n\s*-- 0113[^\n]*\n(\s*-- [^\n]*\n)*/, "\n");
    body = body.replace(/\n\s*select coalesce\(array_agg\(a\.id\)[^\n]*\n/, "\n");
    body = body.replace(/\n\s*perform set_config\('nopm\.deletion_commit'[^\n]*\n/, "\n");
    body = body.replace(/\n\s*-- W2-09:[\s\S]*?from closed c;\n/, "\n");
    body = body.replace("  v_alloc uuid[] := '{}';\n", "");
    const old = read("20261017000056_review_fixes.sql");
    const start = old.indexOf("create or replace function nopm_commit_task_deletion(");
    const oldBody = old.slice(start, old.indexOf("revoke execute on function nopm_commit_task_deletion", start));
    const squash = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(squash(body)).toBe(squash(oldBody));
  });

  it("the project commit sets it too (since 0102), and every function that can delete from a cascading parent does", () => {
    // The LATEST definition of every function, over all migrations in order.
    const latest = new Map<string, string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      const text = read(f);
      const re = /create or replace function (\w+)\(/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text))) {
        const next = text.indexOf("create or replace function ", match.index + 10);
        latest.set(match[1], text.slice(match.index, next === -1 ? undefined : next));
      }
    }
    const DELETES = /delete\s+from\s+(tasks|projects|resource_members|programs|sprints|allocations|clashes)\b/i;
    const deleters = [...latest.entries()].filter(([, body]) => DELETES.test(body));
    const names = deleters.map(([n]) => n).sort();
    // Exactly the commits we know of: nobody else in the schema deletes these tables or their cascading parents.
    expect(names).toEqual(
      [
        "nopm_commit_allocation_deletion",
        "nopm_commit_clash_deletion",
        "nopm_commit_program_deletion",
        "nopm_commit_project_deletion",
        "nopm_commit_resource_deletion",
        "nopm_commit_sprint_deletion",
        "nopm_commit_task_deletion",
      ].sort(),
    );
    for (const [name, body] of deleters) {
      expect(body, `${name} sets nopm.deletion_commit`).toContain("set_config('nopm.deletion_commit', 'on', true)");
    }
  });
});

describe("0113 closes the requests that go away with a parent (W2-09)", () => {
  const SWEPT = "target_type in (";
  it("the project commit also sweeps pending sprint, allocation and clash requests", () => {
    const body = fn(m113, "nopm_commit_project_deletion");
    expect(body).toContain("target_type in ('task', 'risk', 'issue', 'expense', 'document', 'milestone', 'sprint', 'allocation', 'clash')");
    expect(body).toContain("union all select id from sprints where project_id = r.target_id");
    expect(body).toContain("union all select id from allocations where workspace_id = p_workspace_id and (project_id = r.target_id or task_id in");
    expect(body).toContain("union all select id from clashes where workspace_id = p_workspace_id and (project_a_id = r.target_id or project_b_id = r.target_id)");
    expect(body).toContain("set_config('nopm.deletion_commit', 'on', true)");
  });

  it("the task and resource commits sweep pending allocation requests, with one audit row each", () => {
    for (const name of ["nopm_commit_task_deletion", "nopm_commit_resource_deletion"]) {
      const body = fn(m113, name);
      expect(body, name).toContain(SWEPT + "'allocation')");
      expect(body, name).toContain("closed_reason = 'parent_deleted'");
      expect(body, name).toContain("'deletion_request.withdrawn'");
    }
    expect(fn(m113, "nopm_commit_task_deletion")).toContain("from allocations a where a.task_id = r.target_id");
    // the ids are read BEFORE the cascade removes them
    const task = fn(m113, "nopm_commit_task_deletion");
    expect(task.indexOf("into v_alloc")).toBeLessThan(task.indexOf("delete from tasks"));
  });

  it("the allocation entity row records a display name for the Approvals card (D2)", () => {
    expect(m113).toContain("jsonb_build_object(''display_name''");
  });

  it("says why the commit functions are not security definer (W2-10)", () => {
    expect(m113).toMatch(/NOT security definer, deliberately, exactly like the other deletion commits/);
  });
});

describe("0113 fixed tier (D15)", () => {
  it("lifts a normal program deletion request to high_risk in the database, next to project and expense", () => {
    const body = fn(m113, "nopm_deletion_tier_default");
    expect(body).toContain("new.target_type in ('project', 'program')");
    expect(body).toContain("elsif new.target_type = 'expense'");
    expect(body).toContain("approval_policy ->> 'currency_threshold'");
  });
});

describe("0114 refuse triggers (post-deploy, PR-19)", () => {
  it("says it is applied AFTER the deploy and why", () => {
    expect(m114.split("\n").slice(0, 3).join("\n")).toMatch(/POST-DEPLOY/);
    expect(m114).toMatch(/ORDER OF APPLY\. After 0113 AND after the build is live/);
    expect(m114).toMatch(/-- ROLLBACK/);
  });

  it("attaches nopm_refuse_direct_delete as a BEFORE DELETE row trigger to exactly the five tables", () => {
    const triggers = [...m114.matchAll(/create trigger (\w+)\s+before delete on (\w+)\s+for each row execute function nopm_refuse_direct_delete\(\);/g)];
    expect(triggers.map((t) => t[2]).sort()).toEqual([...FIVE_TABLES].sort());
    for (const [, name, table] of triggers) {
      expect(name).toBe(`trg_${table}_delete_needs_request`);
      expect(m114).toContain(`drop trigger if exists ${name} on ${table};`);
    }
  });

  it("refuses to run unless 0113 is applied and every cascading commit sets the flag", () => {
    expect(m114).toContain("to_regprocedure('nopm_refuse_direct_delete()') is null");
    for (const f of [
      "nopm_commit_task_deletion",
      "nopm_commit_project_deletion",
      "nopm_commit_program_deletion",
      "nopm_commit_sprint_deletion",
      "nopm_commit_resource_deletion",
      "nopm_commit_allocation_deletion",
      "nopm_commit_clash_deletion",
    ]) {
      expect(m114).toContain(`'${f}'`);
    }
    // W2-11: the call itself, in EVERY overload, not a mention in a comment
    expect(m114).toContain("position('set_config(''nopm.deletion_commit''' in src) = 0");
    expect(m114).toContain("for src in");
    expect(m114).not.toContain("order by p.oid desc limit 1");
    expect(m114.match(/raise exception '0114:/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("changes no data and creates no function", () => {
    expect(m114).not.toMatch(/\n\s*(delete from|insert into|update) /i);
    expect(m114).not.toMatch(/create (or replace )?function/i);
  });
});
