// NoPM local-DB probe — principal four-eyes + calendar feeds at the API layer.
//
// Runs against a LOCAL `next start` (APP_URL, default http://localhost:3000)
// that is wired to the same LOCAL Supabase stack the fixtures are created in.
// guard.mjs refuses any non-loopback target. See README for how to start the app.
//
//   cd web && node scripts/local-db/probe-api.mjs
//
// Proves, through the real routes:
//   - a requester can never approve/reject their own request, with ANY identity
//     of theirs (own PAT, own session, a PAT they minted, either direction)
//   - wildcard scopes ("task:*", "change:*", "*") never grant the approve/decide verbs
//   - a token with no recorded owner can never approve
//   - a different human (PAT or session) succeeds, with the right audit evidence
//   - the same holds for change requests, and the calendar feed lifecycle works
//
// Exit codes: 0 all PASS · 1 at least one FAIL · 2 guard refused · 3 stack/app down.
import "./guard.mjs";
import { needAnonKey } from "./guard.mjs";
import { call, requireApp, sessionCookie } from "./app-client.mjs";
import { createReport, expect, expectEqual } from "./report.mjs";
import { connect, createFixtures, newTask } from "./fixtures.mjs";

needAnonKey();
const { db, pgc, close } = await connect();
await requireApp();
const report = createReport("principal four-eyes + calendar feed — API layer");
const fx = await createFixtures({ db });
const cookies = {
  a: await sessionCookie(fx.a),
  b: await sessionCookie(fx.b),
};
console.log(`[fixtures] workspace=${fx.workspaceId}`);

const T = fx.tokens;
const bearer = (t) => ({ token: t.raw });

/** Raise a task deletion through the REAL route as the given caller. */
async function raiseDeletion(caller) {
  const task = await newTask(db, fx, "api-doomed");
  const r = await call("DELETE", `/api/tasks/${task.id}`, { ...caller, body: { reason: "probe: four-eyes" } });
  expectEqual(r.status, 202, `raising a deletion request failed: ${r.text.slice(0, 200)}`);
  return { task, id: r.json.data.id };
}

const approve = (id, caller, body) => call("POST", `/api/deletion-requests/${id}/approve`, { ...caller, ...(body ? { body } : {}) });
const reject = (id, caller, reason = "probe: not needed") => call("POST", `/api/deletion-requests/${id}/reject`, { ...caller, body: { reason } });

async function dbState(id, taskId) {
  const r = await pgc.query(
    `select status, requested_principal_id, requested_by_id, approved_principal_id, approved_by_id
       from deletion_requests where id = $1 and workspace_id = $2`,
    [id, fx.workspaceId],
  );
  const t = await pgc.query("select 1 from tasks where id = $1", [taskId]);
  return { ...r.rows[0], taskExists: t.rowCount === 1 };
}
const expectUntouched = async (req) => {
  const s = await dbState(req.id, req.task.id);
  expectEqual([s.status, s.taskExists], ["pending", true], "the request/task must be untouched after a refused decision");
};
const expectDenied = (r, status, code, what) => {
  expectEqual(r.status, status, `${what}: HTTP status (body ${r.text.slice(0, 160)})`);
  expectEqual(r.json?.code, code, `${what}: error code (message: ${r.json?.error})`);
};

// ── 0. the app is on THIS stack ───────────────────────────────────────────
await report.check("API0", "a PAT minted in the local stack authenticates against the app (app uses the local DB)", async () => {
  const r = await call("GET", "/api/deletion-requests?status=pending", bearer(T.a));
  expectEqual(r.status, 200, `GET /api/deletion-requests (is the app wired to the local stack?) ${r.text.slice(0, 160)}`);
});

// ── 1. the server stamps the requester's PRINCIPAL ────────────────────────
await report.check("API1", "raising via A's PAT records requester principal = A (token owner), actor = the token", async () => {
  const req = await raiseDeletion(bearer(T.a));
  const s = await dbState(req.id, req.task.id);
  expectEqual([s.requested_by_id, s.requested_principal_id], [T.a.id, fx.a.id], "requested_by_id / requested_principal_id");
  const sess = await raiseDeletion({ cookie: cookies.a });
  const s2 = await dbState(sess.id, sess.task.id);
  expectEqual([s2.requested_by_id, s2.requested_principal_id], [fx.a.id, fx.a.id], "session raise: requested_by_id / requested_principal_id");
});

// ── 2. self-approval, every identity of A ─────────────────────────────────
await report.check("API2", "A's own PAT cannot approve a request A's PAT raised -> 403 self_approval", async () => {
  const req = await raiseDeletion(bearer(T.a));
  expectDenied(await approve(req.id, bearer(T.a)), 403, "self_approval", "A PAT approves A PAT");
  await expectUntouched(req);
});

await report.check("API3", "A's SESSION cannot approve a request A's PAT raised -> 403 self_approval", async () => {
  const req = await raiseDeletion(bearer(T.a));
  expectDenied(await approve(req.id, { cookie: cookies.a }), 403, "self_approval", "A session approves A PAT request");
  await expectUntouched(req);
});

await report.check("API4", "A's PAT cannot approve a request A's SESSION raised -> 403 self_approval", async () => {
  const req = await raiseDeletion({ cookie: cookies.a });
  expectDenied(await approve(req.id, bearer(T.a)), 403, "self_approval", "A PAT approves A session request");
  await expectUntouched(req);
});

await report.check("API5", "self-rejection is refused too: same actor 422, same HUMAN other identity 403", async () => {
  const req = await raiseDeletion(bearer(T.a));
  const sameActor = await reject(req.id, bearer(T.a));
  expectEqual(sameActor.status, 422, `A PAT rejects A PAT request (body ${sameActor.text.slice(0, 160)})`);
  const sameHuman = await reject(req.id, { cookie: cookies.a });
  expectDenied(sameHuman, 403, "self_approval", "A session rejects A PAT request");
  await expectUntouched(req);
});

// ── 3. wildcards never grant the approve verbs ────────────────────────────
await report.check("API6", "wildcard PATs ('task:*', '*') of a DIFFERENT human cannot approve -> 403 forbidden_scope", async () => {
  const req = await raiseDeletion(bearer(T.a));
  expectDenied(await approve(req.id, bearer(T.bWild)), 403, "forbidden_scope", "task:* approves");
  expectDenied(await approve(req.id, bearer(T.bStar)), 403, "forbidden_scope", "* approves");
  expectDenied(await reject(req.id, bearer(T.bWild)), 403, "forbidden_scope", "task:* rejects");
  await expectUntouched(req);
});

// ── 4. no recorded owner => cannot decide ─────────────────────────────────
await report.check("API7", "a PAT with no recorded owner (created_by null) cannot approve or reject -> 403 no_principal", async () => {
  const req = await raiseDeletion(bearer(T.a));
  expectDenied(await approve(req.id, bearer(T.orphan)), 403, "no_principal", "orphan approves");
  expectDenied(await reject(req.id, bearer(T.orphan)), 403, "no_principal", "orphan rejects");
  await expectUntouched(req);
});

// ── 5. a different human succeeds ─────────────────────────────────────────
await report.check("API8", "B's PAT approves A's request -> 200; committed; evidence recorded; replay -> 422", async () => {
  const req = await raiseDeletion(bearer(T.a));
  const r = await approve(req.id, bearer(T.b), { note: "probe: approved" });
  expectEqual(r.status, 200, `B PAT approves (body ${r.text.slice(0, 200)})`);
  const s = await dbState(req.id, req.task.id);
  expectEqual([s.status, s.taskExists, s.approved_by_id, s.approved_principal_id], ["committed", false, T.b.id, fx.b.id], "db state after approve");
  const audit = await pgc.query(
    `select action, channel, "after" from audit_log where workspace_id = $1 and target_id = any($2::uuid[]) order by action`,
    [fx.workspaceId, [req.id, req.task.id]],
  );
  const actions = audit.rows.map((x) => x.action);
  expect(actions.includes("task.delete") && actions.includes("deletion_request.approved"), `audit actions: ${actions}`);
  const gov = audit.rows.find((x) => x.action === "deletion_request.approved");
  expectEqual([gov.channel, gov.after?.approver_principal_id, gov.after?.note], ["api", fx.b.id, "probe: approved"], "governance audit row");
  const again = await approve(req.id, bearer(T.b));
  expectEqual(again.status, 422, `replayed approve (body ${again.text.slice(0, 160)})`);
});

await report.check("API9", "B's SESSION approves a request A's PAT raised -> 200 (channel ui)", async () => {
  const req = await raiseDeletion(bearer(T.a));
  const r = await approve(req.id, { cookie: cookies.b });
  expectEqual(r.status, 200, `B session approves (body ${r.text.slice(0, 200)})`);
  const s = await dbState(req.id, req.task.id);
  expectEqual([s.status, s.approved_by_id, s.approved_principal_id], ["committed", fx.b.id, fx.b.id], "db state after approve");
  const ch = await pgc.query(
    `select channel from audit_log where workspace_id = $1 and target_id = $2 and action = 'deletion_request.approved'`,
    [fx.workspaceId, req.id],
  );
  expectEqual(ch.rows.map((x) => x.channel), ["ui"], "session approval channel");
});

await report.check("API10", "B's PAT rejects A's request with a reason -> 200; status rejected; task kept", async () => {
  const req = await raiseDeletion(bearer(T.a));
  const r = await reject(req.id, bearer(T.b), "probe: out of scope");
  expectEqual(r.status, 200, `B PAT rejects (body ${r.text.slice(0, 200)})`);
  const s = await dbState(req.id, req.task.id);
  expectEqual([s.status, s.taskExists, s.approved_principal_id], ["rejected", true, fx.b.id], "db state after reject");
});

// ── 6. change requests: same rules ────────────────────────────────────────
async function raiseChange(caller) {
  const r = await call("POST", `/api/projects/${fx.project.id}/change-requests`, { ...caller, body: { title: `probe change ${Date.now()}`, description: "probe" } });
  expectEqual(r.status, 201, `raising a change request failed: ${r.text.slice(0, 200)}`);
  return r.json.data.id;
}
const decide = (id, caller, decision = "approve") =>
  call("POST", `/api/change-requests/${id}/decision`, { ...caller, body: { decision, rationale: "probe decision" } });

await report.check("API11", "change request: A's PAT cannot decide A's session-raised request; wildcard cannot; B's PAT can; replay 422", async () => {
  const id = await raiseChange({ cookie: cookies.a });
  expectDenied(await decide(id, bearer(T.a)), 403, "self_approval", "A PAT decides A session CR");
  expectDenied(await decide(id, { cookie: cookies.a }), 403, "self_approval", "A session decides A session CR");
  expectDenied(await decide(id, bearer(T.bWild)), 403, "forbidden_scope", "change:* decides");
  expectDenied(await decide(id, bearer(T.orphan)), 403, "no_principal", "orphan decides");
  const still = await pgc.query("select status from change_requests where id = $1", [id]);
  expectEqual(still.rows[0].status, "raised", "change request must still be raised");

  const ok = await decide(id, bearer(T.b));
  expectEqual(ok.status, 200, `B PAT decides (body ${ok.text.slice(0, 200)})`);
  const done = await pgc.query(
    `select status, decided_principal_id, requested_principal_id from change_requests where id = $1`,
    [id],
  );
  expectEqual(done.rows[0], { status: "approved", decided_principal_id: fx.b.id, requested_principal_id: fx.a.id }, "decided row");
  expectEqual((await decide(id, bearer(T.b))).status, 422, "replayed decision");
});

await report.check("API12", "change request raised by A's PAT: A's SESSION cannot decide it (reverse direction)", async () => {
  const id = await raiseChange(bearer(T.a));
  expectDenied(await decide(id, { cookie: cookies.a }), 403, "self_approval", "A session decides A PAT CR");
});

// ── 7. calendar feed lifecycle (W4) ───────────────────────────────────────
await report.check("CAL1", "feed: create (URL returned once) -> fetch .ics with the milestone -> bad token 404 -> revoke -> 404", async () => {
  const created = await call("POST", "/api/calendar-feeds", { ...bearer(T.a), body: { name: `probe feed ${fx.tag}` } });
  expectEqual(created.status, 201, `create feed (body ${created.text.slice(0, 200)})`);
  const url = new URL(created.json.data.url);
  expect(/^\/api\/calendar\/npc_[A-Za-z0-9_-]{43}\.ics$/.test(url.pathname), `unexpected feed path ${url.pathname}`);
  expect(!("token_hash" in created.json.data), "token_hash must never be returned");

  const feed = await call("GET", url.pathname);
  expectEqual(feed.status, 200, `fetch feed (body ${feed.text.slice(0, 120)})`);
  expect(/^text\/calendar/.test(feed.headers.get("content-type") ?? ""), `content-type ${feed.headers.get("content-type")}`);
  const unfolded = feed.text.replace(/\r?\n[ \t]/g, ""); // RFC 5545 line folding
  expect(unfolded.includes("BEGIN:VCALENDAR") && unfolded.includes(fx.milestone.name), "feed must contain the workspace milestone");

  const bad = await call("GET", `/api/calendar/npc_${"A".repeat(43)}.ics`);
  expectEqual(bad.status, 404, "unknown token must 404");

  const list = await call("GET", "/api/calendar-feeds", bearer(T.a));
  expectEqual(list.status, 200, "list feeds");
  expect(!JSON.stringify(list.json).includes("token_hash"), "list must not expose token_hash");

  const id = created.json.data.id;
  const other = await call("DELETE", `/api/calendar-feeds/${id}`, bearer(T.b));
  expectEqual(other.status, 403, `a teammate who is not admin must not revoke A's feed (got ${other.status})`);
  const revoked = await call("DELETE", `/api/calendar-feeds/${id}`, bearer(T.a));
  expectEqual(revoked.status, 200, `owner revokes (body ${revoked.text.slice(0, 160)})`);
  expectEqual((await call("GET", url.pathname)).status, 404, "revoked feed must 404");
});

await report.check("CAL2", "a PAT with no recorded owner cannot create a feed -> 403", async () => {
  const r = await call("POST", "/api/calendar-feeds", { ...bearer(T.orphan), body: { name: "orphan feed" } });
  expectEqual(r.status, 403, `orphan creates feed (body ${r.text.slice(0, 160)})`);
});

const allPassed = report.finish();
await close();
process.exit(allPassed ? 0 : 1);
