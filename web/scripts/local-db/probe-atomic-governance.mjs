// NoPM local-DB probe - governance writes are atomic with their audit row (R-161, R-162, migration 0108).
//
// Calls the 0108 functions directly on the LOCAL database with a throwaway workspace. For every function it proves
// that the happy path writes the change AND exactly one audit row, and that a FAILING audit write (an invalid
// channel) leaves NO change behind, so an orphan row cannot exist. Also checked: the workspace guard, the unique
// violations the routes map (uniq_pending_deletion, uniq_pending_rebaseline), the project-lock backstop, the
// child-count snapshot, the requester guard on edit and withdraw, and the emergency refusal.
//
//   cd web && node scripts/local-db/probe-atomic-governance.mjs      (needs migrations 0107 and 0108 applied locally)
//
// Exit codes: 0 all PASS - 1 at least one FAIL - 2 guard refused - 3 stack down.
import "./guard.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import { createReport, expect, expectEqual as expectEqualRaw } from "./report.mjs";
// jsonb does not keep key order: compare with sorted keys.
const sorted = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const expectEqual = (a, w, m) => expectEqualRaw(sorted(a), sorted(w), m);
import { connect, createFixtures, must, newTask } from "./fixtures.mjs";

const { db, pgc, close } = await connect();
const report = createReport("Atomic governance writes - local database");
const fx = await createFixtures({ db });
const ws = fx.workspaceId;
console.log(`[fixtures] workspace=${ws}`);

const A = fx.a; // requester (manager A)
const B = fx.b; // another person (manager B)
const audit = (action, targetType, user = A, extra = {}) => ({
  action,
  target_type: targetType,
  actor_type: "user",
  actor_id: user.id,
  actor_label: user.label,
  channel: "api",
  request_id: `probe-${randomBytes(3).toString("hex")}`,
  principal_id: user.id,
  ...extra,
});
// A failing audit write: the shared helper refuses an unknown channel, after the change was made in the same call.
const BAD = (action, targetType, user = A) => audit(action, targetType, user, { channel: "bogus" });
const BADRE = /INVALID_CHANNEL|P0005/;

const q = async (sql, params = []) => (await pgc.query(sql, params)).rows;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
// p_note_* are jsonb parameters that may hold a plain string (the route passes any JSON value).
const isJsonParam = (k, v) => isObj(v) || (k.startsWith("p_note_") && v !== null);
const rpc = async (fn, args) => {
  const keys = Object.keys(args);
  const sql = `select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}${isJsonParam(k, args[k]) ? "::jsonb" : ""}`).join(", ")}) as r`;
  const params = keys.map((k) => (isJsonParam(k, args[k]) ? JSON.stringify(args[k]) : args[k]));
  return (await pgc.query(sql, params)).rows[0].r;
};
const rpcFails = async (fn, args, pattern) => {
  try {
    await rpc(fn, args);
  } catch (e) {
    expect(pattern.test(`${e.message} ${e.code ?? ""} ${e.constraint ?? ""}`), `expected ${pattern}, got ${e.code} ${e.message}`);
    return e;
  }
  throw new Error(`${fn} did not fail`);
};
const auditRows = (action, targetId) =>
  q("select * from audit_log where workspace_id = $1 and action = $2 and target_id = $3 order by chain_seq", [ws, action, targetId]);
const auditCount = async () => (await q("select count(*)::int as n from audit_log where workspace_id = $1", [ws]))[0].n;
const count = async (sql, params) => (await q(sql, params))[0].n;

const requestDeletionArgs = (entity, targetId, over = {}) => ({
  p_workspace_id: ws,
  p_entity: entity,
  p_target_id: targetId,
  p_reason: "probe reason",
  p_assigned_approver_id: null,
  p_tier: entity === "project" ? "high_risk" : "normal",
  p_deadline: null,
  p_requested_by_type: "user",
  p_requested_by_id: A.id,
  p_requested_by_label: A.label,
  p_requested_principal_id: A.id,
  p_event_detail: { tier: entity === "project" ? "high_risk" : "normal", deadline: null },
  p_audit: audit(`${entity}.delete_requested`, entity),
  ...over,
});

// ── deletion request: maker step ───────────────────────────────────────────
let taskA;
let reqA;
await report.check("D1", "task deletion request: one row, one task.delete_requested audit row, one deadline_set event", async () => {
  taskA = await newTask(db, fx, "d1");
  const before = await auditCount();
  reqA = await rpc("nopm_request_deletion", requestDeletionArgs("task", taskA.id));
  expect(reqA.status === "pending" && reqA.target_id === taskA.id, "request row not returned");
  expectEqual(await auditCount(), before + 1, "audit rows added");
  const rows = await auditRows("task.delete_requested", taskA.id);
  expectEqual(rows.length, 1, "task.delete_requested rows");
  expect(rows[0].before?.name === taskA.name && rows[0].after === null, "audit before is the task row, after null");
  expect(rows[0].principal_id === A.id && rows[0].chain_seq != null && rows[0].row_hash, "principal and hash chain filled");
  expectEqual(await count("select count(*)::int n from approval_events where target_id = $1 and kind = 'deadline_set'", [reqA.id]), 1, "deadline_set events");
});

await report.check("D2", "a second pending request for the same task is the unique violation and leaves nothing behind", async () => {
  const before = await auditCount();
  await rpcFails("nopm_request_deletion", requestDeletionArgs("task", taskA.id), /23505|uniq_pending_deletion/);
  expectEqual(await auditCount(), before, "audit rows after a refused duplicate");
  expectEqual(await count("select count(*)::int n from deletion_requests where target_id = $1 and status = 'pending'", [taskA.id]), 1, "pending rows");
});

await report.check("D3", "forced audit failure: no deletion_requests row survives", async () => {
  const t = await newTask(db, fx, "d3");
  const before = await auditCount();
  await rpcFails("nopm_request_deletion", requestDeletionArgs("task", t.id, { p_audit: BAD("task.delete_requested", "task") }), BADRE);
  expectEqual(await count("select count(*)::int n from deletion_requests where target_id = $1", [t.id]), 0, "orphan deletion requests");
  expectEqual(await count("select count(*)::int n from approval_events where target_id in (select id from deletion_requests where target_id = $1)", [t.id]), 0, "orphan events");
  expectEqual(await auditCount(), before, "audit rows");
});

await report.check("D4", "project request snapshots child_counts (with the scope fingerprint); locked project is refused (P0010)", async () => {
  const req = await rpc("nopm_request_deletion", requestDeletionArgs("project", fx.project.id));
  expect(isObj(req.before?.child_counts) && req.before.child_counts._scope, "before.child_counts._scope missing");
  expect(req.before.child_counts.tasks >= 1, "child_counts.tasks should include the probe task");
  const rows = await auditRows("project.delete_requested", fx.project.id);
  expectEqual(rows.length, 1, "project.delete_requested rows");
  expect(isObj(rows[0].before?.child_counts), "audit before carries child_counts");
  // withdraw it so the lock test below can raise again
  await rpc("nopm_withdraw_deletion_request", { p_workspace_id: ws, p_request_id: req.id, p_closed_reason: null, p_audit: audit("deletion_request.withdrawn", "deletion_request") });
  const lockedProject = await must(
    db.from("projects").insert({ workspace_id: ws, code: `LK-${randomBytes(2).toString("hex")}`.toUpperCase(), name: "locked probe", owner_id: fx.admin.id, is_locked: true, locked_at: new Date().toISOString(), locked_by_actor_id: fx.admin.id }).select("id").single(),
    "locked project",
  );
  await rpcFails("nopm_request_deletion", requestDeletionArgs("project", lockedProject.id), /P0010|PROJECT_LOCKED/);
});

await report.check("D5", "milestone request carries child_counts.tasks; unknown entity P0060; wrong audit action P0059; no principal P0006", async () => {
  const req = await rpc("nopm_request_deletion", requestDeletionArgs("milestone", fx.milestone.id));
  expect(req.before?.child_counts?.tasks === 0, "milestone child_counts.tasks should be 0");
  await rpcFails("nopm_request_deletion", requestDeletionArgs("widget", randomUUID()), /P0060|UNSUPPORTED_ENTITY|P0059/);
  const t = await newTask(db, fx, "d5");
  await rpcFails("nopm_request_deletion", requestDeletionArgs("task", t.id, { p_audit: audit("task.delete", "task") }), /P0059|INVALID_AUDIT/);
  await rpcFails("nopm_request_deletion", requestDeletionArgs("task", t.id, { p_requested_principal_id: null }), /P0006|NO_PRINCIPAL/);
});

await report.check("D6", "workspace guard: another workspace's target is NOT_FOUND (P0002), nothing written", async () => {
  const other = await must(db.from("workspaces").insert({ name: `Other ${randomBytes(2).toString("hex")}`, slug: `other-${randomBytes(3).toString("hex")}` }).select("id").single(), "other workspace");
  const before = await auditCount();
  await rpcFails("nopm_request_deletion", requestDeletionArgs("task", taskA.id, { p_workspace_id: other.id }), /P0002|NOT_FOUND/);
  expectEqual(await auditCount(), before, "audit rows");
});

// ── deletion request: withdraw and reject ──────────────────────────────────
await report.check("W1", "withdraw: pending -> withdrawn plus one deletion_request.withdrawn row; a second call is ALREADY_DECIDED", async () => {
  const before = await auditCount();
  const r = await rpc("nopm_withdraw_deletion_request", { p_workspace_id: ws, p_request_id: reqA.id, p_closed_reason: null, p_audit: audit("deletion_request.withdrawn", "deletion_request") });
  expectEqual(r.status, "withdrawn", "status");
  expectEqual(await auditCount(), before + 1, "audit rows");
  const rows = await auditRows("deletion_request.withdrawn", reqA.id);
  expect(rows[0].before?.status === "pending" && rows[0].after?.status === "withdrawn" && !("reason" in rows[0].after), "withdraw before/after shape");
  await rpcFails("nopm_withdraw_deletion_request", { p_workspace_id: ws, p_request_id: reqA.id, p_closed_reason: null, p_audit: audit("deletion_request.withdrawn", "deletion_request") }, /P0001|ALREADY_DECIDED/);
  expectEqual(await auditCount(), before + 1, "audit rows after the refused repeat");
});

await report.check("W2", "system close keeps closed_reason and puts it in the audit after", async () => {
  const t = await newTask(db, fx, "w2");
  const req = await rpc("nopm_request_deletion", requestDeletionArgs("task", t.id));
  await rpc("nopm_withdraw_deletion_request", { p_workspace_id: ws, p_request_id: req.id, p_closed_reason: "target_gone", p_audit: audit("deletion_request.withdrawn", "deletion_request", fx.admin) });
  const [row] = await q("select status, closed_reason from deletion_requests where id = $1", [req.id]);
  expect(row.status === "withdrawn" && row.closed_reason === "target_gone", "closed_reason stored");
  const rows = await auditRows("deletion_request.withdrawn", req.id);
  expectEqual(rows[0].after, { status: "withdrawn", reason: "target_gone" }, "audit after");
});

await report.check("W3", "forced audit failure on withdraw: the request stays pending", async () => {
  const t = await newTask(db, fx, "w3");
  const req = await rpc("nopm_request_deletion", requestDeletionArgs("task", t.id));
  await rpcFails("nopm_withdraw_deletion_request", { p_workspace_id: ws, p_request_id: req.id, p_closed_reason: null, p_audit: BAD("deletion_request.withdrawn", "deletion_request") }, BADRE);
  const [row] = await q("select status, decided_at from deletion_requests where id = $1", [req.id]);
  expect(row.status === "pending" && row.decided_at === null, "request must still be pending");
});

await report.check("W4", "reject: status, approver and one deletion_request.rejected row; forced audit failure leaves it pending", async () => {
  const t = await newTask(db, fx, "w4");
  const req = await rpc("nopm_request_deletion", requestDeletionArgs("task", t.id));
  const args = (over = {}) => ({
    p_workspace_id: ws, p_request_id: req.id, p_approver_type: "user", p_approver_id: B.id, p_approver_label: B.label,
    p_approver_principal_id: B.id, p_reason: "not now", p_audit: audit("deletion_request.rejected", "deletion_request", B), ...over,
  });
  await rpcFails("nopm_reject_deletion_request", args({ p_audit: BAD("deletion_request.rejected", "deletion_request", B) }), BADRE);
  expectEqual((await q("select status from deletion_requests where id = $1", [req.id]))[0].status, "pending", "status after failed audit");
  await rpc("nopm_reject_deletion_request", args());
  const [row] = await q("select status, approved_principal_id from deletion_requests where id = $1", [req.id]);
  expect(row.status === "rejected" && row.approved_principal_id === B.id, "rejected with the approver principal");
  const rows = await auditRows("deletion_request.rejected", req.id);
  expectEqual(rows.length, 1, "rejected rows");
  expectEqual(rows[0].after, { status: "rejected", approver_principal_id: B.id, reason: "not now" }, "audit after");
  await rpcFails("nopm_reject_deletion_request", args(), /P0001|ALREADY_DECIDED/);
});

// ── change requests ────────────────────────────────────────────────────────
const crInput = (over = {}) => ({
  project_id: fx.project.id,
  reference_id: `CR-P-${randomBytes(2).toString("hex")}`,
  title: "probe change",
  description: "d",
  category: "scope",
  priority: "medium",
  status: "raised",
  impact_summary: null,
  impact_schedule_days: 3,
  impact_cost: null,
  impact_scope: [{ area: "scope", direction: "increase" }],
  target_date: null,
  requested_by: A.id,
  requested_by_label: A.label,
  requested_by_type: "user",
  requested_by_id: A.id,
  ...over,
});
const raiseArgs = (over = {}) => ({
  p_workspace_id: ws,
  p_input: crInput(),
  p_tier: "normal",
  p_deadline: null,
  p_assigned_approver_id: null,
  p_principal_id: A.id,
  p_event_detail: { tier: "normal", deadline: null, reason: null },
  p_audit: audit("change_request.create", "change_request"),
  ...over,
});
let cr;
await report.check("C1", "raise: row, one change_request.create row whose after is the stored row, one deadline_set event", async () => {
  const before = await auditCount();
  cr = await rpc("nopm_raise_change_request", raiseArgs());
  expect(cr.status === "raised" && cr.tier === "normal" && cr.requested_principal_id === A.id, "row fields");
  expectEqual(await auditCount(), before + 1, "audit rows");
  const rows = await auditRows("change_request.create", cr.id);
  expect(rows[0].before === null && rows[0].after?.id === cr.id && rows[0].after?.reference_id === cr.reference_id, "audit after");
  expectEqual(await count("select count(*)::int n from approval_events where target_id = $1 and kind = 'deadline_set'", [cr.id]), 1, "events");
});

await report.check("C2", "raise: forced audit failure leaves no row; duplicate reference is 23505; emergency tier refused (P0061); no principal P0006", async () => {
  const ref = `CR-F-${randomBytes(2).toString("hex")}`;
  await rpcFails("nopm_raise_change_request", raiseArgs({ p_input: crInput({ reference_id: ref }), p_audit: BAD("change_request.create", "change_request") }), BADRE);
  expectEqual(await count("select count(*)::int n from change_requests where reference_id = $1", [ref]), 0, "orphan change requests");
  await rpcFails("nopm_raise_change_request", raiseArgs({ p_input: crInput({ reference_id: cr.reference_id }) }), /23505/);
  await rpcFails("nopm_raise_change_request", raiseArgs({ p_tier: "emergency" }), /P0061|EMERGENCY_VIA_OTHER_FUNCTION/);
  await rpcFails("nopm_raise_change_request", raiseArgs({ p_principal_id: null }), /P0006|NO_PRINCIPAL/);
});

const editArgs = (id, updates, user = A, over = {}) => ({
  p_workspace_id: ws, p_id: id, p_updates: updates, p_editor_principal: user.id, p_audit: audit("change_request.update", "change_request", user), ...over,
});
await report.check("C3", "edit: applies only the keys sent, before = old row, after = new row; non-requester P0023; failed audit rolls the edit back", async () => {
  const before = await auditCount();
  const updated = await rpc("nopm_edit_change_request", editArgs(cr.id, { title: "renamed", description: null }));
  expect(updated.title === "renamed" && updated.description === null && updated.priority === "medium", "only sent keys changed");
  expectEqual(await auditCount(), before + 1, "audit rows");
  const [row] = await auditRows("change_request.update", cr.id);
  expect(row.before.title === "probe change" && row.after.title === "renamed", "before/after");
  await rpcFails("nopm_edit_change_request", editArgs(cr.id, { title: "hijack" }, B), /P0023|NOT_REQUESTER/);
  await rpcFails("nopm_edit_change_request", editArgs(cr.id, { title: "rolled back" }, A, { p_audit: BAD("change_request.update", "change_request") }), BADRE);
  expectEqual((await q("select title from change_requests where id = $1", [cr.id]))[0].title, "renamed", "title after failed audit");
  await rpcFails("nopm_edit_change_request", editArgs(randomUUID(), { title: "x" }), /P0002|NOT_FOUND/);
});

await report.check("C4", "edit and withdraw refuse a decided request (CR_DECIDED, P0001)", async () => {
  const decided = await rpc("nopm_raise_change_request", raiseArgs({ p_input: crInput({ reference_id: `CR-D-${randomBytes(2).toString("hex")}` }) }));
  await pgc.query(
    `update change_requests set status = 'rejected', decided_by = $2, decided_by_type = 'user', decided_by_id = $2,
            decided_by_label = 'probe', decided_principal_id = $2, decided_at = now(), decision_rationale = 'no'
      where id = $1`,
    [decided.id, B.id],
  );
  await rpcFails("nopm_edit_change_request", editArgs(decided.id, { title: "late" }), /P0001|CR_DECIDED/);
  await rpcFails("nopm_withdraw_change_request", { p_workspace_id: ws, p_id: decided.id, p_editor_principal: A.id, p_audit: audit("change_request.delete", "change_request") }, /P0001|CR_DECIDED/);
});

await report.check("C5", "withdraw: row deleted plus one change_request.delete row (before = row, after null); non-requester refused; failed audit keeps the row", async () => {
  const mine = await rpc("nopm_raise_change_request", raiseArgs({ p_input: crInput({ reference_id: `CR-W-${randomBytes(2).toString("hex")}` }) }));
  const wargs = (user = A, over = {}) => ({ p_workspace_id: ws, p_id: mine.id, p_editor_principal: user.id, p_audit: audit("change_request.delete", "change_request", user), ...over });
  await rpcFails("nopm_withdraw_change_request", wargs(B), /P0023|NOT_REQUESTER/);
  await rpcFails("nopm_withdraw_change_request", wargs(A, { p_audit: BAD("change_request.delete", "change_request") }), BADRE);
  expectEqual(await count("select count(*)::int n from change_requests where id = $1", [mine.id]), 1, "row after failed audit");
  const before = await auditCount();
  await rpc("nopm_withdraw_change_request", wargs());
  expectEqual(await count("select count(*)::int n from change_requests where id = $1", [mine.id]), 0, "row after withdraw");
  expectEqual(await auditCount(), before + 1, "audit rows");
  const [row] = await auditRows("change_request.delete", mine.id);
  expect(row.before?.id === mine.id && row.after === null, "audit before/after");
});

// ── rebaseline ─────────────────────────────────────────────────────────────
const rbArgs = (projectId, over = {}) => ({
  p_workspace_id: ws, p_project_id: projectId, p_reason: "slip", p_tier: "normal", p_deadline: null, p_assigned_approver_id: null,
  p_requested_by: A.id, p_principal_id: A.id, p_note_before: null, p_note_after: null, p_audit: audit("rebaseline.create", "rebaseline"), ...over,
});
await report.check("R1", "propose: unlocked project refused (P0019); locked: version 1, exact dates, notes, one audit row, event", async () => {
  await rpcFails("nopm_propose_rebaseline", rbArgs(fx.project.id), /P0019|PROJECT_NOT_LOCKED/);
  await pgc.query("update projects set start_date = '2026-11-01', target_date = '2026-12-15', baseline_start_date = '2026-11-01', baseline_target_date = '2026-12-01', is_locked = true, locked_at = now(), locked_by_actor_id = $2 where id = $1", [fx.project.id, fx.admin.id]);
  const before = await auditCount();
  const rb = await rpc("nopm_propose_rebaseline", rbArgs(fx.project.id, { p_note_before: "old plan", p_note_after: "" }));
  expect(rb.version === 1 && rb.status === "pending_approval", "version and status");
  expectEqual(rb.before, { start_date: "2026-11-01", target_date: "2026-12-01", note: "old plan" }, "before dates");
  expectEqual(rb.after, { start_date: "2026-11-01", target_date: "2026-12-15" }, "after dates (empty note ignored)");
  expectEqual(await auditCount(), before + 1, "audit rows");
  const [row] = await auditRows("rebaseline.create", rb.id);
  expect(row.before === null && row.after?.id === rb.id, "audit after is the stored row");
  expectEqual(await count("select count(*)::int n from approval_events where target_id = $1 and kind = 'deadline_set'", [rb.id]), 1, "events");
});

await report.check("R2", "a second pending proposal is uniq_pending_rebaseline (23505); forced audit failure leaves no row; unknown project P0002", async () => {
  const e = await rpcFails("nopm_propose_rebaseline", rbArgs(fx.project.id), /23505/);
  expect(/uniq_pending_rebaseline/.test(`${e.message} ${e.detail ?? ""} ${e.constraint ?? ""}`), "constraint name must be visible to the route");
  await pgc.query("update rebaselines set status = 'cancelled' where project_id = $1 and status = 'pending_approval'", [fx.project.id]);
  await rpcFails("nopm_propose_rebaseline", rbArgs(fx.project.id, { p_audit: BAD("rebaseline.create", "rebaseline") }), BADRE);
  expectEqual(await count("select count(*)::int n from rebaselines where project_id = $1", [fx.project.id]), 1, "only the first (cancelled) rebaseline exists");
  await rpcFails("nopm_propose_rebaseline", rbArgs(randomUUID()), /P0002|NOT_FOUND/);
});

// ── every audit row written above chained ──────────────────────────────────
await report.check("X1", "every audit row of this workspace has chain_seq and row_hash (the helper never sets them)", async () => {
  const bad = await count("select count(*)::int n from audit_log where workspace_id = $1 and (chain_seq is null or row_hash is null)", [ws]);
  expectEqual(bad, 0, "unchained audit rows");
});

await report.check("X2", "the seven functions are executable by service_role only", async () => {
  const fns = ["nopm_request_deletion", "nopm_withdraw_deletion_request", "nopm_reject_deletion_request", "nopm_raise_change_request", "nopm_edit_change_request", "nopm_withdraw_change_request", "nopm_propose_rebaseline"];
  for (const f of fns) {
    const [r] = await q(
      `select has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u,
              has_function_privilege('service_role', p.oid, 'execute') s from pg_proc p where p.proname = $1`, [f]);
    expect(r && !r.a && !r.u && r.s, `${f}: anon=${r?.a} authenticated=${r?.u} service_role=${r?.s}`);
  }
});

const allPassed = report.finish();
await close();
process.exit(allPassed ? 0 : 1);
