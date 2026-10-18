/**
 * Wave 5, W5-A (R-161, R-162): migration 0108 text test. The SQL cannot run in unit tests, so this pins what the
 * database functions must keep doing: security definer with a pinned search path, service role only, the audit row
 * written through the shared helper (never a copy of the insert), a workspace filter on every statement, the audit
 * action each function insists on, the parameter names atomic-rpc.ts sends, and the entity map that wave 2 extends
 * with an INSERT. The behaviour itself is exercised by scripts/local-db/probe-atomic-governance.mjs.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDeletionCommitRpc } from "@/lib/governance/deletion-dispatch";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const FILE = "20261018000108_atomic_governance.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf8").replace(/\r\n/g, "\n");
const code = sql.replace(/^\s*--.*$/gm, ""); // comments out
const rpcSource = readFileSync(join(process.cwd(), "src", "lib", "governance", "atomic-rpc.ts"), "utf8");

const FUNCTIONS: Record<string, { action: string; targetTable?: string }> = {
  nopm_request_deletion: { action: "' || p_entity || '.delete_requested" },
  nopm_withdraw_deletion_request: { action: "deletion_request.withdrawn" },
  nopm_reject_deletion_request: { action: "deletion_request.rejected" },
  nopm_raise_change_request: { action: "change_request.create" },
  nopm_edit_change_request: { action: "change_request.update" },
  nopm_withdraw_change_request: { action: "change_request.delete" },
  nopm_propose_rebaseline: { action: "rebaseline.create" },
};

/** The text of one function: from its create line to the `$$;` that ends it. */
function bodyOf(name: string): string {
  const start = code.indexOf(`create or replace function ${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const end = code.indexOf("$$;", code.indexOf("as $$", start));
  return code.slice(start, end + 3);
}

function paramsOf(name: string): string[] {
  const body = bodyOf(name);
  const list = body.slice(body.indexOf("(") + 1, body.indexOf(") returns"));
  return [...list.matchAll(/\b(p_[a-z_]+)\s/g)].map((m) => m[1]);
}

describe("migration 0108: shape", () => {
  it("has a rollback comment at the top and is the next free number after the helper", () => {
    expect(sql.split("\n").slice(0, 4).join("\n")).toMatch(/ROLLBACK\./);
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith("20261018000108_"))).toEqual([FILE]);
    expect(files).toContain("20261018000107_audit_insert_helper.sql");
  });

  it("is additive and re-runnable: if not exists / create or replace / on conflict, never a drop or alter of existing objects", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|column|constraint|index|trigger)\b/i);
    expect(code).not.toMatch(/\balter\s+table\s+(?!nopm_deletion_entities)\w+/i);
    expect(code).toMatch(/create table if not exists nopm_deletion_entities/);
    expect(code).toMatch(/on conflict \(entity\) do nothing/);
    expect(code).not.toMatch(/\bdelete\s+from\s+(?!change_requests\b)/i); // only the change-request withdraw deletes
  });

  it("leaves the emergency raise of 0106 alone", () => {
    expect(code).not.toMatch(/function nopm_raise_emergency_change_request/);
  });

  it("defines exactly the seven functions, once each", () => {
    const defined = [...code.matchAll(/create or replace function (nopm_[a-z_]+)\(/g)].map((m) => m[1]).sort();
    expect(defined).toEqual(Object.keys(FUNCTIONS).sort());
  });
});

describe.each(Object.entries(FUNCTIONS))("%s", (name, spec) => {
  const body = () => bodyOf(name);

  it("is security definer with a pinned search path", () => {
    expect(body()).toMatch(/security definer\s+set search_path = public/);
  });

  it("is executable by the service role only", () => {
    const args = new RegExp(`revoke execute on function ${name}\\(([^)]*)\\)`).exec(code)?.[1];
    expect(args, "grant block lists the signature").toBeTruthy();
    expect(code).toMatch(new RegExp(`revoke execute on function ${name}\\(${args!.replace(/[()]/g, "\\$&")}\\) from public, anon, authenticated;`));
    expect(code).toMatch(new RegExp(`grant\\s+execute on function ${name}\\(${args!.replace(/[()]/g, "\\$&")}\\) to service_role;`));
  });

  it("writes its audit row through nopm_audit_insert, never its own insert into audit_log", () => {
    expect(body()).toMatch(/perform nopm_audit_insert\(/);
    expect(body()).not.toMatch(/insert into audit_log/i);
  });

  it("refuses an audit object whose action is not the one it audits", () => {
    expect(body()).toMatch(/\(p_audit ->> 'action'\) is distinct from/);
    if (name !== "nopm_request_deletion") expect(body()).toContain(`'${spec.action}'`);
    else expect(body()).toContain("(p_entity || '.delete_requested')");
  });

  it("filters every statement by the workspace id parameter", () => {
    const b = body();
    // every select / update / delete against a table, up to its terminating semicolon, names workspace_id
    const reads = [...b.matchAll(/\b(?:from|update|delete from)\s+(change_requests|deletion_requests|rebaselines|projects|nopm_deletion_entities|approval_events)\b[^;]*;/gi)];
    for (const m of reads) {
      if (m[1] === "nopm_deletion_entities") continue; // the entity map is global configuration, not tenant data
      expect(m[0], `${name}: ${m[0].slice(0, 80)}`).toMatch(/workspace_id\s*=\s*p_workspace_id/);
    }
    // every insert lists workspace_id among its columns
    for (const m of b.matchAll(/insert into (\w+)\s*\(([^)]*)\)/gi)) {
      expect(m[2], `${name}: insert into ${m[1]}`).toMatch(/workspace_id/);
    }
    // dynamic SQL (the entity table) carries it too
    for (const m of b.matchAll(/execute format\(([^;]*);/g)) expect(m[1]).toMatch(/workspace_id = \$2/);
  });

  it("takes the parameters atomic-rpc.ts sends, by name", () => {
    const at = rpcSource.indexOf(`rpc("${name}", {`);
    expect(at, `atomic-rpc.ts calls ${name}`).toBeGreaterThan(-1);
    const sent = [...rpcSource.slice(at, rpcSource.indexOf("\n  });", at)).matchAll(/\b(p_[a-z_]+):/g)].map((m) => m[1]).sort();
    expect(paramsOf(name).sort()).toEqual(sent);
  });
});

describe("the deletion maker step", () => {
  const body = bodyOf("nopm_request_deletion");

  it("takes the snapshot inside the transaction: the target row under a key-share lock, plus child counts from the entity map", () => {
    expect(body).toMatch(/for key share/);
    expect(body).toMatch(/execute ent\.child_count_sql into v_counts using p_workspace_id, p_target_id/);
    expect(body).toMatch(/jsonb_build_object\('child_counts'/);
  });

  it("repeats the project-lock rule for project, task and milestone (P0010) and needs a principal (P0006)", () => {
    expect(body).toMatch(/p_entity in \('project', 'task', 'milestone'\)/);
    expect(body).toMatch(/errcode = 'P0010'/);
    expect(body).toMatch(/errcode = 'P0006'/);
  });

  it("leaves duplicates to uniq_pending_deletion (no catch of 23505 here) and records the named approver in the audit after", () => {
    expect(body).not.toMatch(/unique_violation|23505/);
    expect(body).toMatch(/jsonb_build_object\('assigned_approver_id', p_assigned_approver_id\)/);
  });

  it("writes the deadline_set event in the same transaction, not swallowed (W1-11)", () => {
    expect(body).toMatch(/insert into approval_events[\s\S]*'deadline_set'/);
    expect(code).not.toMatch(/exception when others/);
  });

  it("refuses an assigned approver that is not a profile of the workspace (P0064) in all three raising functions", () => {
    for (const name of ["nopm_request_deletion", "nopm_raise_change_request", "nopm_propose_rebaseline"]) {
      expect(bodyOf(name), name).toMatch(/exists \(select 1 from profiles where id = p_assigned_approver_id and workspace_id = p_workspace_id\)[\s\S]*P0064/);
    }
  });
});

describe("the withdraw / reject pair replaces the compensating code of decide.ts", () => {
  it("withdraw is a compare-and-set on pending under a row lock and stores closed_reason only when given", () => {
    const b = bodyOf("nopm_withdraw_deletion_request");
    expect(b).toMatch(/for update/);
    expect(b).toMatch(/r\.status <> 'pending'/);
    expect(b).toMatch(/closed_reason = coalesce\(p_closed_reason, closed_reason\)/);
    expect(b).toMatch(/jsonb_build_object\('status', 'withdrawn', 'reason', p_closed_reason\)/);
  });

  it("reject records the approver and principal and audits status, approver principal and reason", () => {
    const b = bodyOf("nopm_reject_deletion_request");
    expect(b).toMatch(/approved_principal_id = p_approver_principal_id/);
    expect(b).toMatch(/jsonb_build_object\('status', 'rejected', 'approver_principal_id', p_approver_principal_id, 'reason', p_reason\)/);
  });
});

describe("the change-request and rebaseline functions", () => {
  it("raise refuses the emergency tier (it has its own function) and a missing principal", () => {
    const b = bodyOf("nopm_raise_change_request");
    expect(b).toMatch(/p_tier = 'emergency'[\s\S]*errcode = 'P0061'/);
    expect(b).toMatch(/errcode = 'P0006'/);
    expect(b).toMatch(/to_jsonb\(r\)/);
  });

  it("edit and withdraw lock the row and re-check open status and requester (P0001 CR_DECIDED, P0023)", () => {
    for (const name of ["nopm_edit_change_request", "nopm_withdraw_change_request"]) {
      const b = bodyOf(name);
      expect(b).toMatch(/for update/);
      expect(b).toMatch(/status not in \('raised', 'under_review'\)/);
      expect(b).toMatch(/CR_DECIDED' using errcode = 'P0001'/);
      expect(b).toMatch(/NOT_REQUESTER' using errcode = 'P0023'/);
    }
  });

  it("edit applies only the keys sent: every updatable column is guarded by `u ? 'key'`", () => {
    const b = bodyOf("nopm_edit_change_request");
    for (const col of ["title", "description", "category", "priority", "impact_summary", "impact_schedule_days", "impact_cost", "impact_scope", "target_date", "raised_at"]) {
      expect(b, col).toContain(`when u ? '${col}'`);
    }
    // status, tier, decided_* and the requester are never editable here
    expect(b).not.toMatch(/\bstatus\s*=\s*case|\btier\s*=\s*case|requested_principal_id\s*=\s*case/);
  });

  it("propose locks the project, needs it locked (P0019), takes the next version and leaves the unique index to refuse a second pending", () => {
    const b = bodyOf("nopm_propose_rebaseline");
    expect(b).toMatch(/from projects where id = p_project_id and workspace_id = p_workspace_id for update/);
    expect(b).toMatch(/errcode = 'P0019'/);
    expect(b).toMatch(/coalesce\(max\(version\), 0\) \+ 1/);
    expect(b).not.toMatch(/unique_violation|23505/);
    expect(b).toMatch(/'pending_approval'/);
  });
});

describe("the entity map (PR-12): wave 2 adds an entity with an INSERT", () => {
  const seeded = [...code.matchAll(/\(\s*'([a-z]+)',\s*'([a-z_]+)',\s*'(nopm_commit_[a-z_]+)'/g)].map((m) => ({ entity: m[1], table: m[2], rpc: m[3] }));

  it("seeds the seven current entities, each with the commit RPC deletion-dispatch uses", () => {
    expect(seeded.map((s) => s.entity).sort()).toEqual(["document", "expense", "issue", "milestone", "project", "risk", "task"]);
    for (const s of seeded) expect(s.rpc, s.entity).toBe(resolveDeletionCommitRpc(s.entity));
  });

  it("names the child-count statement for project and milestone only, taking $1 workspace and $2 target", () => {
    expect(code).toMatch(/'project',\s*'projects',\s*'nopm_commit_project_deletion',\s*'select nopm_project_child_counts\(\$2\)'/);
    expect(code).toMatch(/'milestone',\s*'milestones',\s*'nopm_commit_milestone_deletion',\s*'select jsonb_build_object\(''tasks'', count\(\*\)\) from tasks where workspace_id = \$1 and milestone_id = \$2'/);
  });

  it("every named commit function is defined by some migration (the column is read here, not by the function)", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n");
    for (const s of seeded) expect(all, s.rpc).toMatch(new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${s.rpc}\\s*\\(`, "i"));
  });

  it("is read-only for the service role (W1-04): the statement column runs as dynamic SQL", () => {
    expect(code).toMatch(/grant select on nopm_deletion_entities to service_role;/);
    expect(code).not.toMatch(/grant\s+(?:select,\s*)?(?:insert|update)[^;]*nopm_deletion_entities/);
  });

  it("is service-role data: RLS on, no access for anon or authenticated", () => {
    expect(code).toMatch(/alter table nopm_deletion_entities enable row level security;/);
    expect(code).toMatch(/revoke all on nopm_deletion_entities from public, anon, authenticated;/);
    expect(code).not.toMatch(/grant[^;]*nopm_deletion_entities to (anon|authenticated)/);
  });
});

describe("error codes", () => {
  it("P0060, P0061 and P0064 are new: no earlier migration uses them", () => {
    const others = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql") && f !== FILE)
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
      .join("\n");
    expect(others).not.toMatch(/P0060|P0061|P0064/);
    expect(code).toMatch(/errcode = 'P0060'/);
    expect(code).toMatch(/errcode = 'P0061'/);
  });
});
