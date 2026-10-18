// NoPM local-DB probe - deletion by request for programs, sprints, resources, allocations and clashes
// (R-176, migrations 0113 and 0114).
//
// Run it twice against the LOCAL database, once with 0113 applied and once after 0114:
//
//   cd web && node scripts/local-db/probe-deletion-registers.mjs
//
// The probe reads whether the five refusing triggers of 0114 exist and says so in its title. The cascade checks
// (approve a task with an allocation, a project with a sprint + allocation + clash, a resource with allocations)
// MUST pass in both modes: that is PR-01, an approved deletion has to keep working once the trigger is attached.
// The raw-delete checks differ by mode: before 0114 a plain DELETE still works (the old build keeps running);
// after 0114 every plain DELETE on the five tables fails with P0040 DELETE_NEEDS_REQUEST.
//
// Exit codes: 0 all PASS - 1 at least one FAIL - 2 guard refused - 3 stack down.
import "./guard.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import { createReport, expect, expectEqual } from "./report.mjs";
import { connect, createFixtures, must, newTask } from "./fixtures.mjs";

const { db, pgc, close } = await connect();
const q = async (sql, params = []) => (await pgc.query(sql, params)).rows;
const count = async (sql, params) => (await q(sql, params))[0].n;

const triggerCount = await count(
  `select count(*)::int n from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and t.tgname like 'trg\\_%\\_delete\\_needs\\_request'
      and c.relname in ('programs', 'sprints', 'resource_members', 'allocations', 'clashes')`,
);
const triggered = triggerCount === 5;
if (triggerCount !== 0 && triggerCount !== 5) {
  console.error(`only ${triggerCount} of the five refusing triggers exist: the database is in a half-applied state`);
  process.exit(1);
}
const report = createReport(`Deletion by request for the five registers - ${triggered ? "AFTER 0114 (triggers attached)" : "AFTER 0113 only (no triggers yet)"}`);
const fx = await createFixtures({ db });
const ws = fx.workspaceId;
console.log(`[fixtures] workspace=${ws}  mode=${triggered ? "after-0114" : "after-0113"}`);

const A = fx.a; // requester (manager)
const B = fx.b; // approver (manager)
const ADMIN = fx.admin; // requester of high-risk requests
const ADMIN2 = fx.admin2; // approver of high-risk requests

const audit = (action, targetType, user) => ({
  action,
  target_type: targetType,
  actor_type: "user",
  actor_id: user.id,
  actor_label: user.label,
  channel: "api",
  request_id: `probe-${randomBytes(3).toString("hex")}`,
  principal_id: user.id,
});
const rpc = async (fn, args) => {
  const keys = Object.keys(args);
  const sql = `select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}${k === "p_audit" || k === "p_event_detail" ? "::jsonb" : ""}`).join(", ")}) as r`;
  const params = keys.map((k) => (k === "p_audit" || k === "p_event_detail" ? JSON.stringify(args[k]) : args[k]));
  return (await pgc.query(sql, params)).rows[0].r;
};
const fails = async (fn, args, pattern) => {
  try {
    await rpc(fn, args);
  } catch (e) {
    expect(pattern.test(`${e.message} ${e.code ?? ""}`), `expected ${pattern}, got ${e.code} ${e.message}`);
    return e;
  }
  throw new Error(`${fn} did not fail`);
};

/** The maker step through the real function, as the route calls it. */
const request = (entity, targetId, by = A, tier = "normal") =>
  rpc("nopm_request_deletion", {
    p_workspace_id: ws,
    p_entity: entity,
    p_target_id: targetId,
    p_reason: "probe reason",
    p_assigned_approver_id: null,
    p_tier: tier,
    p_deadline: null,
    p_requested_by_type: "user",
    p_requested_by_id: by.id,
    p_requested_by_label: by.label,
    p_requested_principal_id: by.id,
    p_event_detail: { tier, deadline: null },
    p_audit: audit(`${entity}.delete_requested`, entity, by),
  });
const commitArgs = (requestId, by) => ({
  p_request_id: requestId,
  p_workspace_id: ws,
  p_approver_type: "user",
  p_approver_id: by.id,
  p_approver_label: by.label,
  p_approver_principal_id: by.id,
  p_channel: "api",
  p_correlation_id: `probe-${fx.tag}`,
});
const commit = (entity, requestId, by = B) => rpc(`nopm_commit_${entity}_deletion`, commitArgs(requestId, by));
const status = async (requestId) => (await q("select status from deletion_requests where id = $1", [requestId]))[0]?.status;
const auditRows = (action, targetId) =>
  q("select * from audit_log where workspace_id = $1 and action = $2 and target_id = $3", [ws, action, targetId]);
const exists = async (table, id) => (await count(`select count(*)::int n from ${table} where id = $1`, [id])) === 1;

// ── seed helpers (service role) ────────────────────────────────────────────
const project = async (label, extra = {}) =>
  must(
    db.from("projects").insert({ workspace_id: ws, code: `${label}-${randomBytes(2).toString("hex")}`.toUpperCase(), name: `${label} ${fx.tag}`, owner_id: fx.admin.id, ...extra }).select("id").single(),
    `project ${label}`,
  );
const member = async (label) =>
  must(db.from("resource_members").insert({ workspace_id: ws, name: `${label} ${fx.tag}`, role_title: "Probe" }).select("id").single(), `member ${label}`);
const allocation = async (memberId, extra = {}) =>
  must(db.from("allocations").insert({ workspace_id: ws, member_id: memberId, allocation_pct: 10, ...extra }).select("id").single(), "allocation");
const sprint = async (projectId, extra = {}) =>
  must(db.from("sprints").insert({ workspace_id: ws, project_id: projectId, name: `Sprint ${randomBytes(2).toString("hex")}`, start_date: "2026-11-02", end_date: "2026-11-13", ...extra }).select("id").single(), "sprint");
const clash = async (projectId) =>
  must(db.from("clashes").insert({ workspace_id: ws, title: `Clash ${randomBytes(2).toString("hex")}`, project_a_id: projectId }).select("id").single(), "clash");
const program = async () =>
  must(db.from("programs").insert({ workspace_id: ws, name: `Program ${randomBytes(2).toString("hex")}` }).select("id").single(), "program");

const base = await project("BASE");

// ── 1. the cascades PR-01 names: approving must keep working in BOTH modes ──
await report.check("K1", "approve a TASK deletion whose task has an allocation: task and allocation go, task.delete is audited", async () => {
  const task = await newTask(db, fx, "doomed");
  const m = await member("k1");
  const al = await allocation(m.id, { task_id: task.id, project_id: fx.project.id });
  const req = await request("task", task.id);
  await commit("task", req.id, B);
  expect(!(await exists("tasks", task.id)) && !(await exists("allocations", al.id)), "task or allocation still present");
  expectEqual(await status(req.id), "committed", "request status");
  expectEqual((await auditRows("task.delete", task.id)).length, 1, "task.delete rows");
});

await report.check("K2", "approve a PROJECT deletion with a sprint, an allocation and a clash: all cascade, project.delete is audited", async () => {
  const p = await project("K2");
  const s = await sprint(p.id);
  const m = await member("k2");
  const al = await allocation(m.id, { project_id: p.id });
  const c = await clash(p.id);
  const req = await request("project", p.id, ADMIN, "high_risk");
  await commit("project", req.id, ADMIN2);
  for (const [t, id] of [["projects", p.id], ["sprints", s.id], ["allocations", al.id], ["clashes", c.id]]) {
    expect(!(await exists(t, id)), `${t} row survived the cascade`);
  }
  expectEqual((await auditRows("project.delete", p.id)).length, 1, "project.delete rows");
});

let resourceReq;
let resourceMember;
await report.check("K3", "approve a RESOURCE deletion that has allocations: member and allocations go, the audit row lists the allocation ids", async () => {
  resourceMember = await member("k3");
  const a1 = await allocation(resourceMember.id, { project_id: base.id });
  const a2 = await allocation(resourceMember.id, { project_id: base.id });
  resourceReq = await request("resource", resourceMember.id);
  expectEqual(resourceReq.before.child_counts.allocations, 2, "child_counts.allocations in the request snapshot");
  expectEqual([...resourceReq.before.child_counts.allocation_ids].sort(), [a1.id, a2.id].sort(), "allocation ids in the request snapshot");
  await commit("resource", resourceReq.id, B);
  expect(!(await exists("resource_members", resourceMember.id)), "member survived");
  expectEqual(await count("select count(*)::int n from allocations where member_id = $1", [resourceMember.id]), 0, "allocations left");
  const rows = await auditRows("resource.delete", resourceMember.id);
  expectEqual(rows.length, 1, "resource.delete rows");
  expectEqual(rows[0].after.cascade_deleted.allocations.count, 2, "audit after: allocation count");
  expectEqual([...rows[0].after.cascade_deleted.allocations.ids].sort(), [a1.id, a2.id].sort(), "audit after: allocation ids");
  expectEqual((await auditRows("deletion_request.approved", resourceReq.id)).length, 1, "deletion_request.approved rows");
});

// ── 2. the five commits, one by one ────────────────────────────────────────
await report.check("P1", "program: the request is high_risk even when the caller asks for normal; a manager approver is refused", async () => {
  const pr = await program();
  const p1 = await project("P1A", { program_id: pr.id });
  await project("P1B", { program_id: pr.id });
  const req = await request("program", pr.id, ADMIN, "normal");
  expectEqual(req.tier, "high_risk", "tier stored");
  expectEqual(req.before.child_counts.projects, 2, "child_counts.projects");
  await fails("nopm_commit_program_deletion", commitArgs(req.id, B), /P0018|ROLE_NOT_PERMITTED/);
  expectEqual(await status(req.id), "pending", "request still pending after the refusal");
  await fails("nopm_commit_program_deletion", commitArgs(req.id, ADMIN), /P0003|SELF_APPROVAL/);
  await commit("program", req.id, ADMIN2);
  expect(!(await exists("programs", pr.id)), "program survived");
  expectEqual(await count("select count(*)::int n from projects where id = $1 and program_id is null", [p1.id]), 1, "project kept and detached");
  expectEqual((await auditRows("program.delete", pr.id)).length, 1, "program.delete rows");
});

await report.check("P2", "program: a project joining after the request makes the approval fail (CHILDREN_CHANGED) and nothing is deleted", async () => {
  const pr = await program();
  const req = await request("program", pr.id, ADMIN);
  await project("P2A", { program_id: pr.id });
  await fails("nopm_commit_program_deletion", commitArgs(req.id, ADMIN2), /P0016|CHILDREN_CHANGED/);
  expect((await exists("programs", pr.id)) && (await status(req.id)) === "pending", "program deleted or request decided");
  expectEqual((await auditRows("program.delete", pr.id)).length, 0, "no program.delete row");
});

await report.check("S1", "sprint: a planned empty sprint is deleted; an active one is refused (SPRINT_NOT_PLANNED); a task attached later is CHILDREN_CHANGED", async () => {
  const s1 = await sprint(base.id);
  const r1 = await request("sprint", s1.id);
  await commit("sprint", r1.id, B);
  expect(!(await exists("sprints", s1.id)), "planned sprint survived");
  expectEqual((await auditRows("sprint.delete", s1.id)).length, 1, "sprint.delete rows");

  const s2 = await sprint(base.id);
  const r2 = await request("sprint", s2.id);
  await pgc.query("update sprints set state = 'active', started_at = now() where id = $1", [s2.id]);
  await fails("nopm_commit_sprint_deletion", commitArgs(r2.id, B), /P0063|SPRINT_NOT_PLANNED/);
  expect(await exists("sprints", s2.id), "active sprint was deleted");

  const s3 = await sprint(base.id);
  const r3 = await request("sprint", s3.id);
  const t = await newTask(db, fx, "attached");
  await pgc.query("update tasks set sprint_id = $1 where id = $2", [s3.id, t.id]);
  await fails("nopm_commit_sprint_deletion", commitArgs(r3.id, B), /P0016|CHILDREN_CHANGED/);
  expect(await exists("sprints", s3.id), "sprint with a late task was deleted");
});

await report.check("R1", "resource: a member with archived timesheets is refused at approval (HAS_TIMESHEET_RECORDS); an allocation added later is CHILDREN_CHANGED", async () => {
  const m = await member("r1");
  const req = await request("resource", m.id);
  await pgc.query(
    `insert into timesheet_submissions (workspace_id, member_id, period_start, period_end, submitted_by, submitted_by_label)
     values ($1, $2, '2026-01-05', '2026-01-11', $3, 'probe')`,
    [ws, m.id, A.id],
  );
  await fails("nopm_commit_resource_deletion", commitArgs(req.id, B), /P0062|HAS_TIMESHEET_RECORDS/);
  expect(await exists("resource_members", m.id), "member with timesheets was deleted");

  const m2 = await member("r1b");
  const req2 = await request("resource", m2.id);
  await allocation(m2.id, { project_id: base.id });
  await fails("nopm_commit_resource_deletion", commitArgs(req2.id, B), /P0016|CHILDREN_CHANGED/);
  expect((await exists("resource_members", m2.id)) && (await status(req2.id)) === "pending", "stale resource request was committed");
});

await report.check("A1", "allocation: approve deletes the row, audits allocation.delete with the row as before; self-approval refused", async () => {
  const m = await member("a1");
  const al = await allocation(m.id, { project_id: base.id });
  const req = await request("allocation", al.id, A);
  await fails("nopm_commit_allocation_deletion", commitArgs(req.id, A), /P0003|SELF_APPROVAL/);
  await commit("allocation", req.id, B);
  expect(!(await exists("allocations", al.id)), "allocation survived");
  const rows = await auditRows("allocation.delete", al.id);
  expectEqual(rows.length, 1, "allocation.delete rows");
  expectEqual(rows[0].before.id, al.id, "audit before is the row");
  expect(rows[0].after === null, "audit after is null");
});

await report.check("C1", "clash: approve deletes the row and audits clash.delete; a second approval is ALREADY_DECIDED", async () => {
  const c = await clash(base.id);
  const req = await request("clash", c.id, A);
  await commit("clash", req.id, B);
  expect(!(await exists("clashes", c.id)), "clash survived");
  expectEqual((await auditRows("clash.delete", c.id)).length, 1, "clash.delete rows");
  await fails("nopm_commit_clash_deletion", commitArgs(req.id, B), /P0001|ALREADY_DECIDED/);
});

await report.check("G1", "a request for a record that is already gone is TARGET_GONE and commits nothing", async () => {
  const c = await clash(base.id);
  const req = await request("clash", c.id, A);
  await pgc.query("select set_config('nopm.deletion_commit', 'on', false)");
  await pgc.query("delete from clashes where id = $1", [c.id]);
  await pgc.query("select set_config('nopm.deletion_commit', 'off', false)");
  await fails("nopm_commit_clash_deletion", commitArgs(req.id, B), /P0017|TARGET_GONE/);
  expectEqual(await status(req.id), "pending", "request status");
});

await report.check("G2", "the request function snapshots the row and refuses an unknown target (P0002) and a second pending request (23505)", async () => {
  await fails("nopm_request_deletion", {
    p_workspace_id: ws, p_entity: "clash", p_target_id: randomUUID(), p_reason: "x", p_assigned_approver_id: null, p_tier: "normal",
    p_deadline: null, p_requested_by_type: "user", p_requested_by_id: A.id, p_requested_by_label: A.label, p_requested_principal_id: A.id,
    p_event_detail: {}, p_audit: audit("clash.delete_requested", "clash", A),
  }, /P0002|NOT_FOUND/);
  const c = await clash(base.id);
  await request("clash", c.id, A);
  try {
    await request("clash", c.id, A);
    throw new Error("second request did not fail");
  } catch (e) {
    expect(e.code === "23505", `expected 23505, got ${e.code} ${e.message}`);
  }
});

// ── 3. a plain DELETE: allowed before 0114, refused after ──────────────────
const raw = {
  programs: () => program(),
  sprints: () => sprint(base.id),
  resource_members: () => member("raw"),
  allocations: async () => allocation((await member("rawal")).id, { project_id: base.id }),
  clashes: () => clash(base.id),
};
for (const [table, make] of Object.entries(raw)) {
  await report.check(
    `W-${table}`,
    triggered ? `plain DELETE on ${table} is refused with P0040` : `plain DELETE on ${table} still works (old build keeps running)`,
    async () => {
      const row = await make();
      if (triggered) {
        try {
          await pgc.query(`delete from ${table} where id = $1`, [row.id]);
          throw new Error("delete went through");
        } catch (e) {
          expect(e.code === "P0040", `expected P0040, got ${e.code} ${e.message}`);
        }
        expect(await exists(table, row.id), "row vanished although the delete was refused");
      } else {
        await pgc.query(`delete from ${table} where id = $1`, [row.id]);
        expect(!(await exists(table, row.id)), "row survived the plain delete");
      }
    },
  );
}

if (triggered) {
  await report.check("W-cascade", "a plain DELETE of a task that has an allocation is refused too (the cascade hits the trigger: why the commit RPCs set the flag)", async () => {
    const task = await newTask(db, fx, "rawcascade");
    const al = await allocation((await member("rawcasc")).id, { task_id: task.id, project_id: base.id });
    try {
      await pgc.query("delete from tasks where id = $1", [task.id]);
      throw new Error("delete went through");
    } catch (e) {
      expect(e.code === "P0040", `expected P0040, got ${e.code} ${e.message}`);
    }
    expect((await exists("tasks", task.id)) && (await exists("allocations", al.id)), "task or allocation vanished although the delete was refused");
  });
}

await report.check("X1", "the five commit functions are executable by service_role only", async () => {
  for (const f of ["program", "sprint", "resource", "allocation", "clash"].map((e) => `nopm_commit_${e}_deletion`)) {
    const [r] = await q(
      `select has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u,
              has_function_privilege('service_role', p.oid, 'execute') s from pg_proc p where p.proname = $1`, [f]);
    expect(r && !r.a && !r.u && r.s, `${f}: anon=${r?.a} authenticated=${r?.u} service_role=${r?.s}`);
  }
});

await report.check("X2", "every audit row of this workspace is chained", async () => {
  expectEqual(await count("select count(*)::int n from audit_log where workspace_id = $1 and (chain_seq is null or row_hash is null)", [ws]), 0, "unchained audit rows");
});

const allPassed = report.finish();
await close();
process.exit(allPassed ? 0 : 1);
