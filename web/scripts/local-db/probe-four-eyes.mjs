// NoPM local-DB probe — principal-aware four-eyes at the DATABASE layer.
//
// Proves (against a LOCAL stack only — guard.mjs enforces it) that migration
// 20261016000045 (W1) makes the HUMAN, not the actor id, the four-eyes
// comparand, and that 0046 (W3a) did not weaken audit immutability while
// adding the 'lark' channel. Everything goes through the same two doors the
// app uses: supabase-js with the service-role key (PostgREST RPC + inserts) and
// — where we need SQLSTATE/constraint names — a direct Postgres connection.
//
//   cd web && node scripts/local-db/probe-four-eyes.mjs
//
// Exit codes: 0 all PASS · 1 at least one FAIL · 2 guard refused · 3 stack down.
import "./guard.mjs";
import { randomUUID } from "node:crypto";
import { CONTRACT, preflight } from "./contracts.mjs";
import { createReport, errText, expect, expectEqual } from "./report.mjs";
import {
  auditCount,
  auditRowsFor,
  commitTaskDeletion,
  connect,
  createFixtures,
  mintToken,
  must,
  newTaskDeletionRequest,
  tryInsert,
} from "./fixtures.mjs";

const { db, pgc, close } = await connect();
const report = createReport("principal four-eyes — database layer");
const fx = await createFixtures({ db });
const { actors } = fx;
console.log(`[fixtures] workspace=${fx.workspaceId} A=${fx.a.id} B=${fx.b.id}`);

// ── helpers ────────────────────────────────────────────────────────────────
const isSelfApproval = (e) => /SELF_APPROVAL/.test(errText(e)) || e?.code === CONTRACT.errcodes.selfApproval;
const isNoPrincipal = (e) => /NO_PRINCIPAL/.test(errText(e)) || e?.code === CONTRACT.errcodes.noPrincipal;

async function requestState(requestId, taskId) {
  const r = await pgc.query(
    `select status, approved_by_id from deletion_requests where id = $1 and workspace_id = $2`,
    [requestId, fx.workspaceId],
  );
  const t = await pgc.query(`select 1 from tasks where id = $1`, [taskId]);
  return { status: r.rows[0]?.status, approvedById: r.rows[0]?.approved_by_id, taskExists: t.rowCount === 1 };
}

/**
 * A rejected-by-CHECK outcome: 23514 AND the named principal CHECK from 0045 (so a
 * pass cannot be credited to some other constraint that happened to fire).
 */
function expectCheckViolation(res, what, constraint) {
  expect(!res.ok, `${what}: the row was ACCEPTED — the principal CHECK is missing or too weak`);
  expectEqual(res.code, "23514", `${what}: wrong SQLSTATE (message: ${res.message})`);
  if (constraint) expectEqual(res.constraint, constraint, `${what}: rejected by the wrong constraint`);
  return `rejected by CHECK ${res.constraint ?? "(unnamed)"}`;
}

// ── P0 preflight: do the assumptions in contracts.mjs hold? ────────────────
await report.check("P0", "migrations 0045-0047 objects present (columns, tables, RPC param)", async () => {
  const problems = await preflight(pgc);
  expect(problems.length === 0, `contract mismatch -> ${problems.join("; ")}`);
});

// ── (a) self-approval is rejected, whatever the actor id ───────────────────
await report.check("A1", "A's own PAT cannot commit a deletion A's PAT raised (principal A == A)", async () => {
  const { task, request } = await newTaskDeletionRequest(db, fx, actors.aToken);
  const before = await auditCount(pgc, fx.workspaceId);
  const { error } = await commitTaskDeletion(db, fx, request.id, actors.aToken);
  expect(error && isSelfApproval(error), `expected SELF_APPROVAL, got ${error ? errText(error) : "success"}`);
  const s = await requestState(request.id, task.id);
  expectEqual([s.status, s.taskExists], ["pending", true], "request/task must be untouched");
  expectEqual(await auditCount(pgc, fx.workspaceId), before, "a rejected approval must write zero audit rows");
});

await report.check("A2", "principal, not actor id, decides: B's token id + principal A -> SELF_APPROVAL", async () => {
  const { task, request } = await newTaskDeletionRequest(db, fx, actors.aToken);
  const spoof = { ...actors.bToken, principalId: fx.a.id }; // different actor id, same human as the requester
  const { error } = await commitTaskDeletion(db, fx, request.id, spoof);
  expect(error && isSelfApproval(error), `expected SELF_APPROVAL, got ${error ? errText(error) : "success"}`);
  expectEqual((await requestState(request.id, task.id)).status, "pending", "request must stay pending");
});

await report.check("A3", "retroactive hole closed: raised by A's SESSION, approved by A's PAT -> SELF_APPROVAL", async () => {
  // Before 0045 the actor ids differed (profile id vs api_tokens.id) so this committed.
  const { task, request } = await newTaskDeletionRequest(db, fx, actors.aUser);
  const { error } = await commitTaskDeletion(db, fx, request.id, actors.aToken);
  expect(error && isSelfApproval(error), `expected SELF_APPROVAL, got ${error ? errText(error) : "success"}`);
  const s = await requestState(request.id, task.id);
  expectEqual([s.status, s.taskExists], ["pending", true], "request/task must be untouched");
});

await report.check("A4", "reverse hole closed: raised by A's PAT, approved by A's SESSION -> SELF_APPROVAL", async () => {
  const { task, request } = await newTaskDeletionRequest(db, fx, actors.aToken);
  const { error } = await commitTaskDeletion(db, fx, request.id, actors.aUser);
  expect(error && isSelfApproval(error), `expected SELF_APPROVAL, got ${error ? errText(error) : "success"}`);
  expectEqual((await requestState(request.id, task.id)).status, "pending", "request must stay pending");
});

// ── (b) a different human succeeds, with exactly the expected audit rows ───
await report.check("B1", "B (different human) commits A's request; task gone; exactly 2 audit rows", async () => {
  const { task, request } = await newTaskDeletionRequest(db, fx, actors.aToken);
  const before = await auditCount(pgc, fx.workspaceId);
  const { data, error } = await commitTaskDeletion(db, fx, request.id, actors.bToken);
  expect(!error, `expected success, got ${errText(error)}`);
  expect(data?.committed === true, `RPC did not report committed: ${JSON.stringify(data)}`);

  const s = await requestState(request.id, task.id);
  expectEqual([s.status, s.taskExists, s.approvedById], ["committed", false, actors.bToken.id], "post-commit state");

  const decider = CONTRACT.columns.deletion_requests.decider;
  const p = await pgc.query(`select ${decider} as principal from deletion_requests where id = $1`, [request.id]);
  expectEqual(p.rows[0].principal, fx.b.id, `deletion_requests.${decider} must record the approving HUMAN`);

  expectEqual((await auditCount(pgc, fx.workspaceId)) - before, 2, "commit must write exactly 2 audit rows");
  const rows = await auditRowsFor(pgc, fx.workspaceId, [task.id, request.id]);
  expectEqual(
    rows.map((r) => `${r.action}@${r.target_type}`).sort(),
    ["deletion_request.approved@deletion_request", "task.delete@task"],
    "audit actions",
  );
  expect(
    rows.every((r) => r.actor_type === "token" && r.actor_id === actors.bToken.id && r.channel === "api"),
    `audit rows must carry the approving actor + channel: ${JSON.stringify(rows)}`,
  );
});

await report.check("B2", "replaying the commit -> ALREADY_DECIDED, no extra audit rows", async () => {
  const { request } = await newTaskDeletionRequest(db, fx, actors.aToken);
  const first = await commitTaskDeletion(db, fx, request.id, actors.bToken);
  expect(!first.error, `first commit failed: ${errText(first.error)}`);
  const before = await auditCount(pgc, fx.workspaceId);
  const again = await commitTaskDeletion(db, fx, request.id, actors.bToken);
  expect(again.error && /ALREADY_DECIDED/.test(errText(again.error)), `expected ALREADY_DECIDED, got ${errText(again.error) || "success"}`);
  expectEqual(await auditCount(pgc, fx.workspaceId), before, "replay must not write audit rows");
});

await report.check("B3", "approver note + approving HUMAN recorded in the audit `after` (UC-12); no note when omitted", async () => {
  const withNote = await newTaskDeletionRequest(db, fx, actors.aToken);
  const r1 = await commitTaskDeletion(db, fx, withNote.request.id, actors.bToken, { p_note: "probe: looks right" });
  expect(!r1.error, `commit with note failed: ${errText(r1.error)}`);
  const noNote = await newTaskDeletionRequest(db, fx, actors.aToken);
  const r2 = await commitTaskDeletion(db, fx, noNote.request.id, actors.bToken);
  expect(!r2.error, `commit without note failed: ${errText(r2.error)}`);
  const governance = async (reqId) =>
    (await auditRowsFor(pgc, fx.workspaceId, [reqId])).find((r) => r.action === "deletion_request.approved")?.after;
  const a1 = await governance(withNote.request.id);
  const a2 = await governance(noNote.request.id);
  expectEqual([a1?.approver_principal_id, a1?.note], [fx.b.id, "probe: looks right"], "audit after (with note)");
  expectEqual([a2?.approver_principal_id, a2?.note], [fx.b.id, undefined], "audit after (without note)");
});

// ── (c) a null principal can never approve ─────────────────────────────────
await report.check("C1", "null principal (explicit null) -> NO_PRINCIPAL; nothing written", async () => {
  const { task, request } = await newTaskDeletionRequest(db, fx, actors.aToken);
  const before = await auditCount(pgc, fx.workspaceId);
  const { error } = await commitTaskDeletion(db, fx, request.id, actors.orphanToken);
  expect(error && isNoPrincipal(error), `expected NO_PRINCIPAL, got ${error ? errText(error) : "success"}`);
  const s = await requestState(request.id, task.id);
  expectEqual([s.status, s.taskExists], ["pending", true], "request/task must be untouched");
  expectEqual(await auditCount(pgc, fx.workspaceId), before, "a rejected approval must write zero audit rows");
});

await report.check("C2", "null principal beats a legitimate-looking approver id (B's token id, principal null)", async () => {
  const { request } = await newTaskDeletionRequest(db, fx, actors.aToken);
  const { error } = await commitTaskDeletion(db, fx, request.id, { ...actors.bToken, principalId: null });
  expect(error && isNoPrincipal(error), `expected NO_PRINCIPAL, got ${error ? errText(error) : "success"}`);
});

// ── (d) the old RPC overloads are gone ─────────────────────────────────────
await report.check("D1", "old parameter set (no principal) no longer resolves — 'function does not exist'", async () => {
  // The exact exploit shape: a request raised by A's session, "approved" by A's PAT through the
  // pre-0045 signature. If the old overload survived this would COMMIT (actor ids differ).
  const { task, request } = await newTaskDeletionRequest(db, fx, actors.aUser);
  const { data, error } = await db.rpc(CONTRACT.rpc.task, {
    p_request_id: request.id,
    p_workspace_id: fx.workspaceId,
    p_approver_type: actors.aToken.type,
    p_approver_id: actors.aToken.id,
    p_approver_label: actors.aToken.label,
    p_channel: "api",
    p_correlation_id: `probe-${fx.tag}-old`,
  });
  const s = await requestState(request.id, task.id);
  expect(!(data && data.committed), "OLD OVERLOAD STILL COMMITS — four-eyes bypass is open");
  expectEqual([s.status, s.taskExists], ["pending", true], "request/task must be untouched");
  expect(error, "call unexpectedly succeeded without an error");
  expect(
    error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(errText(error)),
    `expected 'function does not exist', got: ${errText(error)}`,
  );
  return `PostgREST said: ${error.code ?? ""} ${String(error.message).slice(0, 90)}`;
});

await report.check("D2", "catalog: every commit overload takes the principal; 0020/0044 signatures gone", async () => {
  for (const fn of [CONTRACT.rpc.task, CONTRACT.rpc.project]) {
    const r = await pgc.query(
      `select pg_get_function_identity_arguments(p.oid) as args, p.proargnames
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [fn],
    );
    expect(r.rowCount >= 1, `${fn} does not exist`);
    for (const row of r.rows) {
      expect((row.proargnames ?? []).includes(CONTRACT.rpc.principalParam), `${fn}(${row.args}) lacks ${CONTRACT.rpc.principalParam} — a bypass overload`);
    }
    expectEqual(r.rowCount, 1, `${fn} must have exactly one overload`);
  }
  for (const sig of [
    "nopm_commit_task_deletion(uuid,uuid,text,uuid,text)",
    "nopm_commit_task_deletion(uuid,uuid,text,uuid,text,text,text)",
    "nopm_commit_project_deletion(uuid,uuid,text,uuid,text)",
    "nopm_commit_project_deletion(uuid,uuid,text,uuid,text,text,text)",
  ]) {
    const r = await pgc.query("select to_regprocedure($1) as oid", [sig]);
    expect(r.rows[0].oid === null, `${sig} is still callable`);
  }
});

await report.check("D3", "RPCs stay service-role only (anon/authenticated cannot EXECUTE)", async () => {
  for (const fn of [CONTRACT.rpc.task, CONTRACT.rpc.project]) {
    const r = await pgc.query(
      `select p.oid::regprocedure::text as sig,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authed,
              has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [fn],
    );
    for (const row of r.rows) {
      expect(!row.anon && !row.authed, `${row.sig} is executable by anon/authenticated`);
      expect(row.svc, `${row.sig} is not executable by service_role`);
    }
  }
});

// ── (e) the CHECK constraints are the backstop when a code path omits the guard ──
await report.check("E1", "change_requests CHECK: decider principal == requester principal rejected (control accepted)", async () => {
  const c = CONTRACT.columns.change_requests;
  const base = (suffix) => ({
    workspace_id: fx.workspaceId,
    project_id: fx.project.id,
    title: `probe cr ${suffix}`,
    status: "approved",
    requested_by: fx.a.id,
    requested_by_type: "user",
    requested_by_id: fx.a.id,
    requested_by_label: fx.a.label,
    [c.requester]: fx.a.id,
    decided_by_label: "probe",
    decided_at: new Date().toISOString(),
  });
  // Control: B (a different human) decides — must be accepted, proving the row shape is valid.
  const control = await tryInsert(pgc, "change_requests", {
    ...base("control"),
    decided_by: fx.b.id,
    decided_by_type: "user",
    decided_by_id: fx.b.id,
    [c.decider]: fx.b.id,
  });
  expect(control.ok, `control row (different human) was rejected: ${control.message}`);
  // Mutant: A's PAT decides A's own session-raised request. The ACTOR ids differ (so the pre-0045
  // cr_maker_checker passes) — only the principal CHECK can stop it.
  const mutant = await tryInsert(pgc, "change_requests", {
    ...base("mutant"),
    decided_by: null,
    decided_by_type: "token",
    decided_by_id: fx.tokens.a.id,
    [c.decider]: fx.a.id,
  });
  return expectCheckViolation(mutant, "change_requests (user -> own token)", CONTRACT.checks.change_requests);
});

await report.check("E2", "change_requests CHECK: two tokens of the SAME human cannot request + decide", async () => {
  const c = CONTRACT.columns.change_requests;
  const a2 = await mintToken(db, { workspaceId: fx.workspaceId, name: "probe A second", createdBy: fx.a.id, scopes: ["task:read"] });
  const mutant = await tryInsert(pgc, "change_requests", {
    workspace_id: fx.workspaceId,
    project_id: fx.project.id,
    title: "probe cr token-token",
    status: "rejected",
    requested_by: null,
    requested_by_type: "token",
    requested_by_id: fx.tokens.a.id,
    requested_by_label: "probe A",
    [c.requester]: fx.a.id,
    decided_by: null,
    decided_by_type: "token",
    decided_by_id: a2.id,
    decided_by_label: "probe A second",
    decided_at: new Date().toISOString(),
    [c.decider]: fx.a.id,
  });
  return expectCheckViolation(mutant, "change_requests (token -> sibling token, same human)", CONTRACT.checks.change_requests);
});

await report.check("E3", "timesheet_submissions CHECK: decider principal == submitter principal rejected (control accepted)", async () => {
  const c = CONTRACT.columns.timesheet_submissions;
  const week = (monday) => ({
    workspace_id: fx.workspaceId,
    member_id: fx.a.memberId,
    period_start: monday,
    period_end: new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10),
    hours_total: 8,
    entry_count: 1,
    status: "approved",
    submitted_by: fx.a.id,
    submitted_by_type: "user",
    submitted_by_label: fx.a.label,
    [c.requester]: fx.a.id,
    decided_by_label: "probe",
    decided_at: new Date().toISOString(),
  });
  const control = await tryInsert(pgc, "timesheet_submissions", {
    ...week("2026-02-02"),
    decided_by: fx.b.id,
    decided_by_type: "user",
    [c.decider]: fx.b.id,
  });
  expect(control.ok, `control row (different human) was rejected: ${control.message}`);
  const mutant = await tryInsert(pgc, "timesheet_submissions", {
    ...week("2026-02-09"),
    decided_by: fx.tokens.a.id, // actor id differs from submitted_by -> pre-0045 ts_maker_checker passes
    decided_by_type: "token",
    [c.decider]: fx.a.id,
  });
  return expectCheckViolation(mutant, "timesheet_submissions (user -> own token)", CONTRACT.checks.timesheet_submissions);
});

await report.check("E4", "deletion_requests CHECK: approved principal == requester principal rejected", async () => {
  const c = CONTRACT.columns.deletion_requests;
  const mutant = await tryInsert(pgc, "deletion_requests", {
    workspace_id: fx.workspaceId,
    target_type: "task",
    target_id: randomUUID(),
    status: "committed",
    requested_by_type: "user",
    requested_by_id: fx.a.id,
    requested_by_label: fx.a.label,
    approved_by_type: "token",
    approved_by_id: fx.tokens.a.id, // differs from requested_by_id -> pre-0045 maker_checker_different passes
    approved_by_label: "probe A",
    decided_at: new Date().toISOString(),
    [c.requester]: fx.a.id,
    [c.decider]: fx.a.id,
  });
  return expectCheckViolation(mutant, "deletion_requests (user -> own token)", CONTRACT.checks.deletion_requests);
});

await report.check("E5", "rebaseline sign-off trigger compares principals (token-raised rebaseline, user, spoofed id)", async () => {
  const rc = CONTRACT.columns.rebaselines.requester;
  const sc = CONTRACT.columns.rebaseline_signoffs.decider;
  const newRebaseline = (requestedBy, principal, version) =>
    must(
      db
        .from("rebaselines")
        .insert({ workspace_id: fx.workspaceId, project_id: fx.project.id, version, status: "draft", reason: "probe", requested_by: requestedBy, [rc]: principal })
        .select("id")
        .single(),
      "rebaseline",
    );
  const signoff = (rebaselineId, approverId, principal) =>
    tryInsert(pgc, "rebaseline_signoffs", { workspace_id: fx.workspaceId, rebaseline_id: rebaselineId, approver_id: approverId, [sc]: principal });
  const selfSignoff = (res, what) => {
    expect(!res.ok, `${what}: sign-off ACCEPTED — the requester signed off their own rebaseline`);
    expect(/SELF_SIGNOFF/.test(res.message) || res.code === CONTRACT.errcodes.selfApproval, `${what}: wrong rejection (${res.code}: ${res.message})`);
  };

  // Token-raised: requested_by is user-only so it is NULL — before 0045 nothing was compared at all.
  const tokenRaised = await newRebaseline(null, fx.a.id, 1);
  selfSignoff(await signoff(tokenRaised.id, fx.a.id, fx.a.id), "token-raised, owner signs off");
  // Spoof: a different approver_id but the same human recorded as the voter.
  selfSignoff(await signoff(tokenRaised.id, fx.b.id, fx.a.id), "token-raised, approver_id=B but principal=A");
  // User-raised: legacy profile comparison still applies.
  const userRaised = await newRebaseline(fx.a.id, fx.a.id, 2);
  selfSignoff(await signoff(userRaised.id, fx.a.id, fx.a.id), "user-raised, requester signs off");
  // Control: B legitimately signs off both.
  const ok1 = await signoff(tokenRaised.id, fx.b.id, fx.b.id);
  expect(ok1.ok, `control sign-off by B rejected: ${ok1.message}`);
});

// ── project-deletion RPC parity (0045 recreates both RPCs) ────────────────
async function newProjectDeletionRequest(by) {
  const project = await must(
    db.from("projects").insert({ workspace_id: fx.workspaceId, code: `DEL-${randomUUID().slice(0, 4)}`, name: "probe doomed project" }).select("*").single(),
    "doomed project",
  );
  const request = await must(
    db
      .from("deletion_requests")
      .insert({
        workspace_id: fx.workspaceId,
        target_type: "project",
        target_id: project.id,
        reason: "probe: project four-eyes",
        status: "pending",
        requested_by_type: by.type,
        requested_by_id: by.id,
        requested_by_label: by.label,
        before: project,
        [CONTRACT.columns.deletion_requests.requester]: by.principalId,
      })
      .select("*")
      .single(),
    "project deletion request",
  );
  return { project, request };
}
const commitProject = (requestId, approver) =>
  db.rpc(CONTRACT.rpc.project, {
    p_request_id: requestId,
    p_workspace_id: fx.workspaceId,
    p_approver_type: approver.type,
    p_approver_id: approver.id,
    p_approver_label: approver.label,
    [CONTRACT.rpc.principalParam]: approver.principalId,
    p_channel: "api",
    p_correlation_id: `probe-${fx.tag}-project`,
  });

await report.check("P1", "project deletion RPC: same principal -> SELF_APPROVAL; null -> NO_PRINCIPAL", async () => {
  const { project, request } = await newProjectDeletionRequest(actors.aUser);
  const self = await commitProject(request.id, actors.aToken);
  expect(self.error && isSelfApproval(self.error), `expected SELF_APPROVAL, got ${self.error ? errText(self.error) : "success"}`);
  const none = await commitProject(request.id, actors.orphanToken);
  expect(none.error && isNoPrincipal(none.error), `expected NO_PRINCIPAL, got ${none.error ? errText(none.error) : "success"}`);
  const still = await pgc.query("select 1 from projects where id = $1", [project.id]);
  expectEqual(still.rowCount, 1, "project must still exist");
});

await report.check("P2", "project deletion RPC: B commits; project gone; exactly 2 audit rows", async () => {
  const { project, request } = await newProjectDeletionRequest(actors.aToken);
  const before = await auditCount(pgc, fx.workspaceId);
  const { data, error } = await commitProject(request.id, actors.bToken);
  expect(!error && data?.committed === true, `expected committed, got ${errText(error) || JSON.stringify(data)}`);
  const gone = await pgc.query("select 1 from projects where id = $1", [project.id]);
  expectEqual(gone.rowCount, 0, "project must be deleted");
  expectEqual((await auditCount(pgc, fx.workspaceId)) - before, 2, "commit must write exactly 2 audit rows");
});

// ── 'lark' channel through the commit RPCs (a Lark click ends here) ────────
await report.check("L1", "commit RPC accepts p_channel='lark' (audit rows stamped 'lark')", async () => {
  const { task, request } = await newTaskDeletionRequest(db, fx, actors.aToken);
  const { data, error } = await commitTaskDeletion(db, fx, request.id, actors.bToken, { p_channel: "lark" });
  expect(
    !error && data?.committed === true,
    `a Lark-originated approval of a deletion would FAIL here: ${errText(error) || JSON.stringify(data)} ` +
      `(0044's INVALID_CHANNEL guard hardcodes five channels — it must accept 'lark')`,
  );
  const rows = await auditRowsFor(pgc, fx.workspaceId, [task.id, request.id]);
  expect(rows.length === 2 && rows.every((r) => r.channel === "lark"), `audit channels: ${JSON.stringify(rows.map((r) => r.channel))}`);
});

await report.check("L2", "commit RPC still rejects an unknown channel (INVALID_CHANNEL), nothing written", async () => {
  const { task, request } = await newTaskDeletionRequest(db, fx, actors.aToken);
  const before = await auditCount(pgc, fx.workspaceId);
  const { error } = await commitTaskDeletion(db, fx, request.id, actors.bToken, { p_channel: "slack" });
  expect(error && /INVALID_CHANNEL/.test(errText(error)), `expected INVALID_CHANNEL, got ${error ? errText(error) : "success"}`);
  const s = await requestState(request.id, task.id);
  expectEqual([s.status, s.taskExists], ["pending", true], "request/task must be untouched");
  expectEqual(await auditCount(pgc, fx.workspaceId), before, "audit rows must not be written");
});

await report.check("L3", "commit RPCs stamp connector provenance (via_connector_id, external_event_id, external_actor_ref) on BOTH audit rows", async () => {
  const connectorId = randomUUID(); // audit_log.via_connector_id has no FK on purpose: evidence outlives the connector
  const eventId = `probe-evt-${fx.tag}-${randomUUID().slice(0, 8)}`;
  const actorRef = `lark:tenant_${fx.tag}:ou_${fx.tag}`;
  const provenance = { p_channel: "lark", p_via_connector_id: connectorId, p_external_event_id: eventId, p_external_actor_ref: actorRef };

  // task deletion
  const t = await newTaskDeletionRequest(db, fx, actors.aToken);
  const r1 = await commitTaskDeletion(db, fx, t.request.id, actors.bToken, provenance);
  expect(!r1.error && r1.data?.committed === true, `task commit with provenance failed: ${errText(r1.error) || JSON.stringify(r1.data)}`);
  // project deletion
  const p = await newProjectDeletionRequest(actors.aToken);
  const r2 = await db.rpc(CONTRACT.rpc.project, {
    p_request_id: p.request.id,
    p_workspace_id: fx.workspaceId,
    p_approver_type: actors.bToken.type,
    p_approver_id: actors.bToken.id,
    p_approver_label: actors.bToken.label,
    [CONTRACT.rpc.principalParam]: actors.bToken.principalId,
    p_correlation_id: `probe-${fx.tag}-prov`,
    ...provenance,
  });
  expect(!r2.error && r2.data?.committed === true, `project commit with provenance failed: ${errText(r2.error) || JSON.stringify(r2.data)}`);

  for (const [what, ids] of [["task", [t.task.id, t.request.id]], ["project", [p.project.id, p.request.id]]]) {
    const rows = await pgc.query(
      `select action, channel, via_connector_id, external_event_id, external_actor_ref from audit_log
        where workspace_id = $1 and target_id = any($2::uuid[])`,
      [fx.workspaceId, ids],
    );
    expectEqual(rows.rowCount, 2, `${what}: audit rows written by the commit`);
    for (const row of rows.rows) {
      expectEqual(
        [row.channel, row.via_connector_id, row.external_event_id, row.external_actor_ref],
        ["lark", connectorId, eventId, actorRef],
        `${what}: ${row.action} must carry the connector provenance`,
      );
    }
  }
  // Omitted provenance stays NULL (first-party channels are unaffected).
  const plain = await newTaskDeletionRequest(db, fx, actors.aToken);
  const r3 = await commitTaskDeletion(db, fx, plain.request.id, actors.bToken);
  expect(!r3.error, `plain commit failed: ${errText(r3.error)}`);
  const none = await pgc.query(
    `select count(*)::int as n from audit_log where workspace_id = $1 and target_id = any($2::uuid[]) and (via_connector_id is not null or external_event_id is not null or external_actor_ref is not null)`,
    [fx.workspaceId, [plain.task.id, plain.request.id]],
  );
  expectEqual(none.rows[0].n, 0, "a console/API commit must not carry connector provenance");
});

// ── (f) audit_log is still append-only ─────────────────────────────────────
async function freshAuditRow(channel = "api") {
  return must(
    db
      .from("audit_log")
      .insert({
        workspace_id: fx.workspaceId,
        actor_type: "user",
        actor_id: fx.a.id,
        actor_label: fx.a.label,
        action: "probe.immutability",
        target_type: "probe",
        channel,
      })
      .select("id, action")
      .single(),
    "audit_log insert",
  );
}

await report.check("F1", "audit_log UPDATE rejected (PostgREST service role AND direct SQL); row unchanged", async () => {
  const row = await freshAuditRow();
  const viaApi = await db.from("audit_log").update({ action: "probe.tampered" }).eq("id", row.id).select();
  expect(viaApi.error && /append-only/i.test(errText(viaApi.error)), `PostgREST UPDATE should hit the append-only trigger, got ${errText(viaApi.error) || "success"}`);
  let sqlMsg = "";
  try {
    await pgc.query("update audit_log set action = 'probe.tampered' where id = $1", [row.id]);
  } catch (e) {
    sqlMsg = e.message;
  }
  expect(/append-only/i.test(sqlMsg), `direct SQL UPDATE should hit the trigger, got: ${sqlMsg || "success"}`);
  const after = await pgc.query("select action from audit_log where id = $1", [row.id]);
  expectEqual(after.rows[0].action, "probe.immutability", "row must be unchanged");
});

await report.check("F2", "audit_log DELETE rejected (PostgREST service role AND direct SQL); row survives", async () => {
  const row = await freshAuditRow();
  const viaApi = await db.from("audit_log").delete().eq("id", row.id).select();
  expect(viaApi.error && /append-only/i.test(errText(viaApi.error)), `PostgREST DELETE should hit the append-only trigger, got ${errText(viaApi.error) || "success"}`);
  let sqlMsg = "";
  try {
    await pgc.query("delete from audit_log where id = $1", [row.id]);
  } catch (e) {
    sqlMsg = e.message;
  }
  expect(/append-only/i.test(sqlMsg), `direct SQL DELETE should hit the trigger, got: ${sqlMsg || "success"}`);
  expectEqual((await pgc.query("select 1 from audit_log where id = $1", [row.id])).rowCount, 1, "row must survive");
});

await report.check("F3", "audit_log immutability triggers still present and enabled", async () => {
  const r = await pgc.query(
    `select tgname, tgenabled from pg_trigger where tgrelid = 'public.audit_log'::regclass and not tgisinternal`,
  );
  const enabled = new Set(r.rows.filter((x) => x.tgenabled === "O").map((x) => x.tgname));
  for (const t of ["trg_audit_no_update", "trg_audit_no_delete"]) expect(enabled.has(t), `${t} missing or disabled`);
});

// ── (g) the 'lark' channel + provenance columns ───────────────────────────
await report.check("G1", "audit_log accepts channel 'lark' with external_event_id / external_actor_ref", async () => {
  const eventId = `probe-evt-${fx.tag}`;
  const { error } = await db.from("audit_log").insert({
    workspace_id: fx.workspaceId,
    actor_type: "user",
    actor_id: fx.b.id,
    actor_label: fx.b.label,
    action: "probe.lark",
    target_type: "probe",
    channel: "lark",
    external_event_id: eventId,
    external_actor_ref: `lark:tenant:ou_${fx.tag}`,
  });
  expect(!error, `insert with channel 'lark' failed: ${errText(error)}`);
  const r = await pgc.query("select channel, external_event_id, external_actor_ref from audit_log where external_event_id = $1", [eventId]);
  expectEqual([r.rowCount, r.rows[0].channel], [1, "lark"], "row must be stored with channel 'lark'");
});

await report.check("G2", "audit_log rejects an unknown channel (CHECK), all legacy channels + null still accepted", async () => {
  const bad = await tryInsert(pgc, "audit_log", {
    workspace_id: fx.workspaceId,
    actor_type: "user",
    actor_label: "probe",
    action: "probe.badchannel",
    target_type: "probe",
    channel: "slack",
  });
  const note = expectCheckViolation(bad, "audit_log channel 'slack'");
  for (const ch of [...CONTRACT.auditChannels, null]) {
    const ok = await tryInsert(pgc, "audit_log", {
      workspace_id: fx.workspaceId,
      actor_type: "user",
      actor_label: "probe",
      action: "probe.goodchannel",
      target_type: "probe",
      channel: ch,
    });
    expect(ok.ok, `channel ${JSON.stringify(ch)} should be accepted: ${ok.message}`);
  }
  return note;
});

// ── done ──────────────────────────────────────────────────────────────────
const allPassed = report.finish();
await close();
process.exit(allPassed ? 0 : 1);
