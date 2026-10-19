/**
 * Approval tiers + timers - migration-text drift test (migrations 0100 + 0101, audit gaps G1-G4, G7).
 *
 * No live Postgres in this suite, so, like change-request-implemented-migration.test.ts, this reads
 * the migrations off disk and asserts the contract the TypeScript layer relies on: the validated
 * policy shape, the tier columns and CHECKs, the relaxed 0092 CHECK, the role-backstop triggers, the
 * recreated RPCs (one overload each) and the single-transaction, tier-guarded auto-approve.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const m100 = readFileSync(join(dir, "20261018000100_approval_tiers.sql"), "utf8");
const m101 = readFileSync(join(dir, "20261018000101_approval_timers.sql"), "utf8");
const fnBody = (sql: string, name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, `${name} defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end + 4);
};

describe("0100: the policy column and its validated shape", () => {
  it("adds workspaces.approval_policy jsonb, not null, default {}", () => {
    expect(m100).toMatch(/add column if not exists approval_policy jsonb not null default '\{\}'::jsonb/);
  });

  it("validates through nopm_approval_policy_valid, NOT VALID then validated in a skip block", () => {
    expect(m100).toMatch(/add constraint workspaces_approval_policy_valid\s+check \(nopm_approval_policy_valid\(approval_policy\)\) not valid/);
    expect(m100).toMatch(/exception when others then\s+raise notice '0100: % left NOT VALID/);
  });

  it("the shape function knows the five tiers, both roles, and allows auto_approve true on routine only", () => {
    const f = fnBody(m100, "nopm_approval_policy_valid");
    for (const t of ["routine", "normal", "high_risk", "emergency", "strategic"]) expect(f).toContain(`'${t}'`);
    expect(f).toMatch(/not in \('manager', 'admin'\)/);
    expect(f).toMatch(/\(v ->> 'auto_approve'\)::boolean and t <> 'routine'/);
    expect(f).toContain("currency_threshold");
    expect(f).toContain("emergency_retro_hours");
    expect(f).toMatch(/turnaround_hours[\s\S]*8760/);
  });
});

describe("0100: tier, deadline and emergency columns", () => {
  it("adds tier (default normal) to all three governed tables and the deadline", () => {
    for (const t of ["change_requests", "deletion_requests", "rebaselines"]) {
      expect(m100).toMatch(new RegExp(String.raw`alter table ${t}\s+add column if not exists tier\s+text\s+not null default 'normal'`));
    }
    expect(m100.match(/approval_deadline_at timestamptz/g)?.length).toBe(3);
  });

  it("change_requests gains the emergency columns", () => {
    for (const c of ["is_emergency         boolean     not null default false", "retro_due_at         timestamptz", "retro_decided_at     timestamptz", "retro_outcome        text"]) {
      expect(m100).toContain(c);
    }
  });

  it("a CHECK per table limits tier to the five names", () => {
    for (const c of ["cr_tier_values", "dr_tier_values", "rb_tier_values"]) {
      expect(m100).toMatch(new RegExp(String.raw`add constraint ${c}\s+check \(tier in \('routine', 'normal', 'high_risk', 'emergency', 'strategic'\)\) not valid`));
    }
  });

  it("emergency shape: the flag and the tier agree, status emergency needs the flag, a retro due date, retro stamps travel together", () => {
    const check = m100.match(/add constraint cr_emergency_shape\s+check \(([\s\S]*?)\) not valid/);
    expect(check, "cr_emergency_shape").toBeTruthy();
    expect(check![1]).toMatch(/is_emergency = \(tier = 'emergency'\)/);
    expect(check![1]).toMatch(/status <> 'emergency' or is_emergency/);
    expect(check![1]).toMatch(/not is_emergency or retro_due_at is not null/);
    expect(check![1]).toMatch(/\(retro_outcome is null\) = \(retro_decided_at is null\)/);
  });

  it("every new CHECK is added NOT VALID and then validated inside a skip-on-failure block", () => {
    const added = [...m100.matchAll(/add constraint (\w+)/g)].map((m) => m[1]);
    for (const name of added) {
      expect(m100, `${name} validated`).toContain(`:${name}'`);
    }
    expect(m100).toMatch(/validate constraint %I/);
  });

  it("no backfill and no updated_at bump: no UPDATE of any governed table, no trigger disabled", () => {
    expect(m100).not.toMatch(/\bupdate (change_requests|deletion_requests|rebaselines)\b\s+set\s+tier/i);
    expect(m100).not.toMatch(/disable trigger/i);
  });
});

describe("0100: the 0092 CHECK is relaxed for emergencies", () => {
  it("cr_implemented_after_decision: an emergency is compared with the raise time, anything else still with the decision", () => {
    const check = m100.match(/add constraint cr_implemented_after_decision\s+check \(([\s\S]*?)\)\s+not valid/);
    expect(check, "cr_implemented_after_decision").toBeTruthy();
    expect(check![1]).toMatch(/implemented_at is null/);
    expect(check![1]).toMatch(/is_emergency and implemented_at >= raised_at/);
    expect(check![1]).toMatch(/decided_at is not null and implemented_at >= decided_at/);
  });

  it("status implemented needs a decision or the emergency flag", () => {
    expect(m100).toMatch(/cr_implemented_needs_decision\s+check \(status <> 'implemented' or decided_at is not null or is_emergency\)/);
  });

  it("cr_maker_checker still demands a different decider, but lets a live emergency wait for its retro decision", () => {
    const check = m100.match(/add constraint cr_maker_checker check \(([\s\S]*?)\) not valid/);
    expect(check, "cr_maker_checker").toBeTruthy();
    expect(check![1]).toMatch(/is_emergency and status in \('emergency', 'implemented'\) and decided_by_id is null/);
    expect(check![1]).toMatch(/decided_by_id <> requested_by_id/);
  });
});

describe("0100: the DB backstop of the approver role", () => {
  it("reads the policy and falls back to the CR A3 defaults", () => {
    const f = fnBody(m100, "nopm_tier_required_role");
    expect(f).toMatch(/approval_policy #>> array\['tiers', p_tier, 'approver_role'\]/);
    expect(f).toMatch(/p_tier in \('high_risk', 'emergency', 'strategic'\) then 'admin' else 'manager'/);
    const g = fnBody(m100, "nopm_principal_meets_tier");
    expect(g).toMatch(/role = 'admin'/);
    expect(g).toMatch(/role = 'manager' and \(nopm_tier_required_role\(p_workspace_id, p_tier\) = 'manager' or nopm_admin_fallback_open\(p_workspace_id\)\)/);
    // D7: the fallback is "fewer than two admins"
    expect(fnBody(m100, "nopm_admin_fallback_open")).toMatch(/role = 'admin'\) < 2/);
  });

  it("change_requests: a trigger refuses a decider below the tier (P0018) and a tier that goes down (P0030)", () => {
    const f = fnBody(m100, "nopm_cr_tier_guard");
    expect(f).toMatch(/nopm_principal_meets_tier\(new\.workspace_id, new\.tier, new\.decided_principal_id\)/);
    expect(f).toContain("errcode = 'P0018'");
    expect(f).toContain("errcode = 'P0030'");
    expect(m100).toMatch(/create trigger trg_cr_tier_guard\s+before insert or update on change_requests/);
  });

  it("the trigger raises the tier on a threshold cost and on money or dates for a routine request, and never reads OLD on insert", () => {
    const f = fnBody(m100, "nopm_cr_tier_guard");
    expect(f).toMatch(/currency_threshold'\)::numeric, 50000/);
    // W4-06: a schedule threshold (default 10 days); the currency is a label, never compared
    expect(f).toMatch(/schedule_threshold_days'\)::numeric, 10/);
    expect(f).not.toMatch(/v_proj_cur|upper\(v_currency\)/);
    // W4-05: scope impact keeps a request out of routine
    expect(f).toMatch(/jsonb_array_length\(new\.impact_scope\) > 0/);
    expect(f).toMatch(/abs\(new\.impact_cost\) >= v_threshold/);
    expect(f).toMatch(/new\.tier = 'routine'\s+and \(v_money or v_dates or \(new\.impact_scope is not null/);
    // OLD is only referenced after an explicit UPDATE guard
    const beforeUpdateGuard = f.slice(0, f.indexOf("if tg_op = 'UPDATE' then"));
    expect(beforeUpdateGuard).not.toMatch(/\bold\./);
  });

  it("deletion_requests: the 0061 function now reads the tier; a project deletion defaults to high_risk", () => {
    expect(fnBody(m100, "nopm_deletion_approver_role")).toMatch(/nopm_principal_meets_tier\(new\.workspace_id, new\.tier, new\.approved_principal_id\)/);
    expect(fnBody(m100, "nopm_deletion_tier_default")).toMatch(/new\.target_type = 'project' and new\.tier = 'normal'/);
    expect(m100).toMatch(/create trigger trg_deletion_tier_default\s+before insert on deletion_requests/);
  });

  it("rebaselines: a sign-off vote is refused below the tier", () => {
    expect(fnBody(m100, "nopm_signoff_tier_role")).toMatch(/nopm_principal_meets_tier\(new\.workspace_id, v_tier,/);
    expect(m100).toMatch(/create trigger trg_signoff_tier_role\s+before insert or update on rebaseline_signoffs/);
  });

  it("the helper functions are not callable by the browser roles", () => {
    for (const f of ["nopm_tier_required_role(uuid, text)", "nopm_principal_meets_tier(uuid, text, uuid)", "nopm_cr_tier_guard()"]) {
      expect(m100).toContain(`revoke execute on function ${f} from public, anon, authenticated`);
    }
  });
});

describe("0100: the recreated RPCs keep their signatures (one overload each)", () => {
  it("nopm_decide_change_request: emergency source, retro source, tier role, retro stamp", () => {
    const f = fnBody(m100, "nopm_decide_change_request");
    expect(f).toMatch(/cr\.status in \('raised', 'under_review', 'emergency'\)/);
    expect(f).toMatch(/cr\.status = 'implemented' and cr\.is_emergency and cr\.retro_decided_at is null/);
    expect(f).toMatch(/nopm_principal_meets_tier\(p_workspace_id, cr\.tier, p_approver_principal_id\)/);
    expect(f).toMatch(/status\s+= case when cr\.status = 'implemented' then 'implemented' else p_new_status end/);
    expect(f).toMatch(/retro_decided_at\s+= case when cr\.is_emergency then now\(\)/);
    expect(f).toMatch(/retro_outcome\s+= case when cr\.is_emergency then p_new_status/);
    expect(f).toContain("'change_request.decide'");
    // still self-approval-proof
    expect(f).toContain("SELF_APPROVAL");
  });

  it("nopm_implement_change_request: an emergency request is implementable before any decision", () => {
    const f = fnBody(m100, "nopm_implement_change_request");
    expect(f).toMatch(/cr\.status = 'approved' or \(cr\.status = 'emergency' and cr\.is_emergency\)/);
    expect(f).toContain("'change_request.implement'");
  });

  it("no two migrations leave two overloads of either function", () => {
    const names = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    for (const fn of ["nopm_decide_change_request", "nopm_implement_change_request"]) {
      const signatures = new Set<string>();
      for (const f of names) {
        const sql = readFileSync(join(dir, f), "utf8");
        for (const m of sql.matchAll(new RegExp(`create or replace function ${fn}\\(([\\s\\S]*?)\\) returns`, "g"))) {
          const types = m[1].replace(/--.*$/gm, "").split(",").map((a) => a.trim().split(/\s+/)[1]);
          signatures.add(types.join(","));
        }
      }
      expect(signatures.size, `${fn} signatures`).toBe(1);
    }
  });
});

describe("W4-10: every SQLSTATE this work introduces is its own", () => {
  const codesOf = (sql: string) => new Set([...sql.matchAll(/errcode = '(P\d{4})'/g)].map((m) => m[1]));

  it("the new codes P0030 to P0035 are used by 0100 and 0101 only, in the repo's whole migration set", () => {
    const names = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const owners = new Map<string, string[]>();
    for (const f of names) {
      for (const c of codesOf(readFileSync(join(dir, f), "utf8"))) owners.set(c, [...(owners.get(c) ?? []), f.slice(0, 14)]);
    }
    for (const c of ["P0030", "P0031", "P0032", "P0033", "P0034", "P0035"]) {
      expect(owners.get(c), c).toBeDefined();
      expect(owners.get(c)!.every((f) => ["20261018000100", "20261018000101"].includes(f)), `${c} owners: ${owners.get(c)}`).toBe(true);
    }
    expect(m100).toContain("P0030 TIER_LOCKED");
    expect(m101).toContain("errcode = 'P0034'");
    expect(m101).toContain("errcode = 'P0035'");
    expect(m100).toContain("errcode = 'P0030'");
    expect(m101).toContain("errcode = 'P0031'");
    expect(m101).toContain("errcode = 'P0032'");
    expect(m101).toContain("errcode = 'P0033'");
  });

  it("no code is used for two meanings anywhere in the migration set (the clash the review found cannot come back)", () => {
    const meaning = new Map<string, Set<string>>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(join(dir, f), "utf8");
      // 'LABEL: text' or 'LABEL' immediately before using errcode = 'Pxxxx'
      for (const m of sql.matchAll(/raise exception '([A-Z_]+)[:' ][^;]*?using errcode = '(P\d{4})'/g)) {
        meaning.set(m[2], (meaning.get(m[2]) ?? new Set()).add(m[1]));
      }
    }
    for (const c of ["P0030", "P0031", "P0032", "P0033", "P0034", "P0035"]) {
      expect(meaning.get(c)?.size, `${c} meanings: ${[...(meaning.get(c) ?? [])]}`).toBe(1);
    }
  });
});

describe("W4-03: nopm_update_workspace_settings", () => {
  const f = fnBody(m101, "nopm_update_workspace_settings");

  it("writes the workspace row and its audit row in one function (one transaction)", () => {
    expect(f.match(/insert into audit_log/g)?.length).toBe(1);
    expect(f).toMatch(/update workspaces w set/);
    expect(f).not.toMatch(/\bcommit\b/i);
    expect(f).toMatch(/for update/);
  });

  it("only these columns are writable, and a pinned value that moved is a stale row", () => {
    for (const col of ["approval_policy", "stale_days", "nudges_enabled", "weekly_report_enabled", "weekly_report_day", "time_zone", "work_event_rules"]) {
      expect(f).toContain(`'${col}'`);
    }
    expect(f).toMatch(/FORBIDDEN_COLUMN/);
    expect(f).toMatch(/distinct from \(v_expect -> v_key\)[\s\S]*STALE_ROW/);
  });

  it("is callable by the service role only", () => {
    expect(m101).toContain("revoke execute on function nopm_update_workspace_settings(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated");
    expect(m101).toContain("grant  execute on function nopm_update_workspace_settings(uuid, jsonb, jsonb, jsonb) to service_role");
  });
});

describe("W4-07 / D7: the fallback approver", () => {
  it("the decide RPC marks fallback_approver in its audit row when only the fallback let the manager through", () => {
    const f = fnBody(m100, "nopm_decide_change_request");
    expect(f).toMatch(/nopm_principal_uses_fallback\(p_workspace_id, cr\.tier, p_approver_principal_id\)/);
    expect(f).toMatch(/jsonb_build_object\('fallback_approver', true\)/);
    expect(fnBody(m100, "nopm_principal_uses_fallback")).toMatch(/nopm_admin_fallback_open/);
  });

  it("the refusal text names who may approve what", () => {
    expect(m100.match(/only %s can approve a % request/g)?.length).toBe(4);
  });
});

describe("0101: the timer ledger", () => {
  it("approval_events has the five kinds and a once-per-kind-per-target unique index", () => {
    for (const k of ["deadline_set", "reminder_sent", "escalated", "auto_approved", "retro_overdue"]) expect(m101).toContain(`'${k}'`);
    expect(m101).toMatch(/create unique index if not exists approval_events_once\s+on approval_events \(target_type, target_id, kind\)/);
  });

  it("RLS is select-only for members and the write grants are revoked from the browser roles", () => {
    expect(m101).toMatch(/alter table approval_events enable row level security/);
    expect(m101).toMatch(/revoke insert, update, delete on approval_events from anon, authenticated/);
    expect(m101).toMatch(/create policy "read approval_events" on approval_events\s+for select using \(workspace_id = nopm_current_workspace\(\)\)/);
    expect(m101).not.toMatch(/create policy[^;]*for (insert|update|delete)/);
  });
});

describe("0101: nopm_auto_approve_routine", () => {
  const f = fnBody(m101, "nopm_auto_approve_routine");

  it("runs only when the workspace policy turned it on (off by default)", () => {
    expect(f).toMatch(/\{tiers,routine,auto_approve\}'\)::boolean, false\) is not true/);
    expect(f).toContain("P0031");
  });

  it("never touches money, dates, emergencies or any tier but routine", () => {
    expect(f).toMatch(/cr\.tier <> 'routine' or cr\.is_emergency/);
    expect(f).toMatch(/coalesce\(cr\.impact_cost, 0\) <> 0 or coalesce\(cr\.impact_schedule_days, 0\) <> 0/);
    expect(f).toContain("P0032");
  });

  it("only a request still waiting and past its deadline", () => {
    expect(f).toMatch(/cr\.status not in \('raised', 'under_review'\)/);
    expect(f).toMatch(/approval_deadline_at > p_now/);
  });

  it("decides as the system actor with no principal, and writes exactly ONE audit row in the same transaction", () => {
    expect(f).toMatch(/c_system constant uuid := '00000000-0000-0000-0000-000000000000'/);
    expect(f).toMatch(/decided_principal_id = null/);
    expect(f).toMatch(/c_label\s+constant text := 'system:auto-approve \(policy\)'/);
    expect(f.match(/insert into audit_log/g)?.length).toBe(1);
    expect(f.match(/insert into approval_events/g)?.length).toBe(1);
    expect(f).toContain("'change_request.decide'");
    expect(f).not.toMatch(/\bcommit\b/i);
    // the row is locked while it is decided
    expect(f).toMatch(/for update/);
  });

  it("is callable by the service role only", () => {
    expect(m101).toContain("revoke execute on function nopm_auto_approve_routine(uuid, uuid, timestamptz) from public, anon, authenticated");
    expect(m101).toContain("grant  execute on function nopm_auto_approve_routine(uuid, uuid, timestamptz) to service_role");
  });
});

describe("0106: emergency = flag only (Q1), approved documents on the manager tier (Q4), expense deletions (Q5)", () => {
  const m106 = readFileSync(join(dir, "20261018000106_tier_decisions.sql"), "utf8");
  const m102 = readFileSync(join(dir, "20261018000102_deletion_by_request_all.sql"), "utf8");

  it("cr_emergency_shape no longer asks for retro_due_at and accepts not_required and retired outcomes", () => {
    const shape = m106.slice(m106.indexOf("add constraint cr_emergency_shape"), m106.indexOf("alter table change_requests drop constraint if exists cr_maker_checker"));
    expect(shape).not.toMatch(/retro_due_at is not null/);
    expect(shape).toContain("'not_required'");
    expect(shape).toContain("'retired'");
    expect(shape).toMatch(/is_emergency = \(tier = 'emergency'\)/);
  });

  it("cr_maker_checker lets an emergency request sit approved with no decider, and keeps the different-human rule for everything else", () => {
    expect(m106).toMatch(/is_emergency and status in \('emergency', 'approved', 'implemented'\) and decided_by_id is null/);
    expect(m106).toMatch(/decided_by_id <> requested_by_id/);
  });

  it("both constraints are re-added NOT VALID and validated in a skip block", () => {
    expect(m106).toMatch(/exception when others then\s+raise notice '0106: % left NOT VALID/);
  });

  it("the decide function keeps its signature, decides only raised / under_review and refuses an emergency", () => {
    const f = fnBody(m106, "nopm_decide_change_request");
    expect(f).toMatch(/if cr\.is_emergency then\s+raise exception 'ALREADY_DECIDED/);
    expect(f).toMatch(/cr\.status not in \('raised', 'under_review'\)/);
    expect(f).not.toMatch(/retro_decided_at/);
    expect(f).not.toContain("'emergency'");
    expect(f).toMatch(/only %s can approve a request at the % tier/);
    expect(f).not.toMatch(/\ba admin\b/);
    expect(m106).toContain("grant  execute on function nopm_decide_change_request(uuid, uuid, text, text, timestamptz, text, uuid, text, uuid, text, text, uuid, text, text) to service_role");
  });

  it("the document commit function has no admin gate and does not raise P0041 or P0042", () => {
    const start = m106.indexOf("create or replace function nopm_commit_document_deletion(");
    expect(start).toBeGreaterThan(-1);
    const f = m106.slice(start, m106.indexOf("revoke execute on function nopm_commit_document_deletion"));
    expect(f).not.toMatch(/errcode = 'P004[12]'/);
    expect(f).not.toContain("APPROVED_DOCUMENT_NEEDS_ADMIN");
    expect(f).toContain("nopm_principal_meets_tier");
    expect(f.indexOf("nopm_principal_meets_tier")).toBeLessThan(f.indexOf("delete from documents"));
    // the same function in 0102 did have the gate (so this really is the change)
    expect(m102).toContain("APPROVED_DOCUMENT_NEEDS_ADMIN");
  });

  it("an expense deletion at or above the workspace threshold becomes high_risk, via the same trigger function as a project", () => {
    const f = fnBody(m106, "nopm_deletion_tier_default");
    expect(f).toMatch(/new\.target_type = 'project'/);
    expect(f).toMatch(/new\.target_type = 'expense'/);
    expect(f).toContain("currency_threshold");
    expect(f).toMatch(/>= coalesce\(v_threshold, 50000\)/);
    expect(f).toMatch(/new\.tier := 'high_risk'/);
  });

  it("the data step is idempotent: it only touches emergencies still waiting, and writes one audit row each", () => {
    expect(m106).toMatch(/where is_emergency and retro_decided_at is null/);
    expect(m106).toContain("retro_outcome      = 'retired'");
    expect(m106).toMatch(/status\s+= case when r\.status = 'emergency' then 'approved' else r\.status end/);
    expect(m106).toContain("'change_request.retro_retired'");
    expect(m106).toMatch(/and d\.tier = 'normal'/);
    expect(m106).toContain("'deletion_request.tier_raised'");
    expect(m106.match(/insert into audit_log/g)?.length).toBe(9); // decide, 3 data steps, 2 document commit, 1 work-event rewrite, 2 emergency raise
  });

  it("C2-02: a trigger refuses an emergency request unless the requester principal is a manager or admin of the workspace", () => {
    const f = fnBody(m106, "nopm_cr_emergency_guard");
    expect(f).toContain("new.is_emergency and not old.is_emergency");
    expect(f).toContain("new.requested_principal_id is null");
    expect(f).toContain("role in ('admin', 'manager')");
    expect(f.match(/errcode = 'P0043'/g)?.length).toBe(2);
    expect(m106).toMatch(/create trigger trg_cr_emergency_guard\s+before insert or update on change_requests/);
  });

  it("C2-03: one function inserts the emergency request and writes both audit rows, service role only", () => {
    const f = fnBody(m106, "nopm_raise_emergency_change_request");
    expect(f).toContain("'change_request.create'");
    expect(f).toContain("'change_request.emergency_commit'");
    expect(f.match(/insert into audit_log/g)?.length).toBe(2);
    expect(f).toContain("'approved', 'emergency', true");
    expect(f).not.toMatch(/commit;/i);
    expect(m106).toContain("grant  execute on function nopm_raise_emergency_change_request(uuid, jsonb, text, uuid, text, uuid, text, text, uuid, text, text) to service_role");
  });

  it("C2-05 and C2-06: the data function lowers approved-document requests and clears a non-admin assignee when raising an expense", () => {
    const f = fnBody(m106, "nopm_apply_tier_decisions");
    expect(f).toContain("'deletion_request.tier_lowered'");
    expect(f).toContain("x.status = 'approved'");
    expect(f).toMatch(/assigned_approver_id = case when v_cleared is not null then null/);
    expect(f).toContain("'cleared_assigned_approver', v_cleared");
  });

  it("C2-07: the data steps live in a re-runnable function that the file calls once", () => {
    expect(m106.trimEnd().endsWith("select nopm_apply_tier_decisions();")).toBe(true);
    expect(m106).toContain("grant  execute on function nopm_apply_tier_decisions() to service_role");
  });

  it("is additive: nothing is dropped except constraints it re-adds, and no new SQLSTATE is taken", () => {
    expect(m106).not.toMatch(/drop (table|column)/i);
    const drops = m106.match(/drop constraint if exists (\w+)/g) ?? [];
    expect(drops.sort()).toEqual(["drop constraint if exists cr_emergency_shape", "drop constraint if exists cr_maker_checker"]);
    expect(m106).not.toMatch(/errcode = 'P003[6-9]'/);
  });
});
