// NoPM local-DB probe - GitHub work events end to end, against the LOCAL app (R-153, audit A1).
//
// Correctly signed fixture payloads (X-Hub-Signature-256 = HMAC-SHA256 of the raw body) are POSTed to
// /api/integrations/github/<connector>/events exactly as GitHub would deliver them. Nothing here talks to
// GitHub: the connector is created through the real admin API and its one-time secret is read from that
// response. Needs migration 0105 applied to the local database.
//
//   cd web && node scripts/local-db/probe-github.mjs
//
// Exit codes: 0 all PASS - 1 at least one FAIL - 2 guard refused - 3 stack/app down.
import "./guard.mjs";
import { needAnonKey } from "./guard.mjs";
import { createHmac, randomUUID } from "node:crypto";
import { call, requireApp, sessionCookie } from "./app-client.mjs";
import { createReport, expect, expectEqual } from "./report.mjs";
import { connect, createFixtures, must } from "./fixtures.mjs";

needAnonKey();
const { db, pgc, close } = await connect();
await requireApp();
const report = createReport("GitHub work events - local app, signed fixture deliveries");
const fx = await createFixtures({ db });
const adminCookie = await sessionCookie(fx.admin);
const tag = fx.tag;
console.log(`[fixtures] workspace=${fx.workspaceId}`);

const REPO = `probe/repo-${tag}`.toLowerCase();
const EVENTS_PATH = (id) => `/api/integrations/github/${id}/events`;
const sign = (raw, secret) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

let connector = null; // { id, secret }

/** POST a signed delivery. */
async function deliver(event, payload, opts = {}) {
  const raw = opts.raw ?? JSON.stringify(payload);
  const headers = { "x-github-event": event, "content-type": "application/json" };
  const signature = opts.signature === undefined ? sign(raw, opts.secret ?? connector.secret) : opts.signature;
  if (signature) headers["x-hub-signature-256"] = signature;
  const id = opts.delivery === undefined ? randomUUID() : opts.delivery;
  if (id) headers["x-github-delivery"] = id;
  return { id, ...(await call("POST", EVENTS_PATH(opts.connectorId ?? connector.id), { raw, headers })) };
}

const pr = (action, number, merged = false) => ({
  action,
  pull_request: { number, merged },
  repository: { full_name: REPO },
  sender: { login: "probe-dev" },
});
const deploy = (state, number) => ({
  deployment: { ref: "main", payload: { pr: number } },
  deployment_status: { state, creator: { login: "probe-bot" } },
  repository: { full_name: REPO },
});

async function newLinkedTask(number, projectId = fx.project.id) {
  return must(
    db
      .from("tasks")
      .insert({
        workspace_id: fx.workspaceId,
        project_id: projectId,
        name: `PR task ${number} ${tag}`,
        external_ref: `github:${REPO}#${number}`,
        source: "github",
      })
      .select("id")
      .single(),
    "task",
  );
}
const taskRow = async (id) =>
  (await pgc.query("select status_type, status from tasks where id = $1", [id])).rows[0];
const auditFor = async (id) =>
  (await pgc.query("select action, channel, via_connector_id, external_event_id, external_actor_ref, actor_type from audit_log where workspace_id = $1 and target_id = $2 order by created_at", [fx.workspaceId, id])).rows;

await report.check("GH0", "admin connects GitHub through the API; the secret is returned once and stored encrypted", async () => {
  const r = await call("POST", "/api/integrations/github/connector", { cookie: adminCookie, body: { name: `probe github ${tag}` } });
  expectEqual(r.status, 201, `create connector (body ${r.text.slice(0, 240)})`);
  const data = r.json.data;
  expect(data?.id && /^npg_/.test(data.webhook_secret ?? ""), "response must carry the connector id and the one-time secret");
  connector = { id: data.id, secret: data.webhook_secret };
  const list = await call("GET", "/api/integrations/github/connector", { cookie: adminCookie });
  expect(!list.text.includes(connector.secret) && !/secret_enc/.test(list.text), "GET leaked the secret");
  const row = (await pgc.query("select kind, status, secret_enc from integration_connectors where id = $1", [connector.id])).rows[0];
  expectEqual(row.kind, "github", "kind");
  expect(!row.secret_enc.includes(connector.secret), "secret stored in plaintext");
});

if (!connector) {
  report.fail("GH-abort", "remaining checks need the connector from GH0", "connector was not created; see GH0 (is migration 0105 applied?)");
  report.finish();
  await close();
  process.exit(1);
}

const t1 = await newLinkedTask(1);

await report.check("GH1", "bad signature, missing signature and a wrong connector id are refused and change nothing", async () => {
  const bad = await deliver("pull_request", pr("opened", 1), { secret: "not-the-secret" });
  expectEqual(bad.status, 401, "tampered signature");
  const none = await deliver("pull_request", pr("opened", 1), { signature: null });
  expectEqual(none.status, 401, "missing signature");
  const unknown = await deliver("pull_request", pr("opened", 1), { connectorId: randomUUID() });
  expectEqual(unknown.status, 401, "unknown connector");
  expectEqual((await taskRow(t1.id)).status_type, "backlog", "task must be untouched");
});

await report.check("GH2", "PR opened moves the linked task to started, with one connector-attributed audit row", async () => {
  const r = await deliver("pull_request", pr("opened", 1));
  expectEqual(r.status, 200, "delivery");
  expectEqual((await taskRow(t1.id)).status_type, "started", "status_type");
  expectEqual((await taskRow(t1.id)).status, "In progress", "label follows the status (UAT-012)");
  const audit = await auditFor(t1.id);
  const rows = audit.filter((a) => a.action === "task.update");
  expectEqual(rows.length, 1, "exactly one task.update audit row");
  expectEqual(rows[0].channel, "github", "channel");
  expectEqual(rows[0].via_connector_id, connector.id, "via_connector_id");
  expectEqual(rows[0].external_event_id, r.id, "external_event_id");
  expectEqual(rows[0].external_actor_ref, "github:probe-dev", "external_actor_ref");
});

await report.check("GH3", "a replayed delivery id answers 200 and changes nothing a second time", async () => {
  const first = await deliver("pull_request", pr("closed", 1, true));
  expectEqual(first.status, 200, "merge delivery");
  expectEqual((await taskRow(t1.id)).status, "In review", "label after merge");
  await pgc.query("update tasks set status_type = 'started', status = 'In progress' where id = $1", [t1.id]);
  const again = await deliver("pull_request", pr("closed", 1, true), { delivery: first.id });
  expectEqual(again.status, 200, "replay");
  expectEqual((await taskRow(t1.id)).status, "In progress", "replay must not move the task again");
  const n = (await pgc.query("select count(*)::int as n from work_events where connector_id = $1 and external_event_id = $2", [connector.id, first.id])).rows[0].n;
  expectEqual(n, 1, "one work_events row for the delivery");
});

await report.check("GH4", "a successful deployment never completes the task (Q7); a failed one only records", async () => {
  const before = await taskRow(t1.id);
  const done = await deliver("deployment_status", deploy("success", 1));
  expectEqual(done.status, 200, "deployment");
  const after = await taskRow(t1.id);
  expectEqual(after.status_type, before.status_type, "a deployment must leave the task status unchanged");
  expect(after.status_type !== "completed", "no work event completes a task");
  const ev1 = (await pgc.query("select applied, reason from work_events where connector_id = $1 and external_event_id = $2", [connector.id, done.id])).rows[0];
  expectEqual(ev1.reason, "no_rule", "recorded, no rule moves the task");
  const t2 = await newLinkedTask(2);
  const failed = await deliver("deployment_status", deploy("failure", 2));
  expectEqual(failed.status, 200, "failure delivery");
  expectEqual((await taskRow(t2.id)).status_type, "backlog", "failure leaves the task");
  const ev = (await pgc.query("select applied, reason from work_events where connector_id = $1 and external_event_id = $2", [connector.id, failed.id])).rows[0];
  expectEqual(ev.reason, "no_rule", "reason");
});

await report.check("GH5", "an unknown PR is recorded, not applied, and writes no audit row", async () => {
  const r = await deliver("pull_request", pr("opened", 999));
  expectEqual(r.status, 200, "delivery");
  const ev = (await pgc.query("select applied, reason, task_id from work_events where connector_id = $1 and external_event_id = $2", [connector.id, r.id])).rows[0];
  expectEqual(ev.reason, "unknown_ref", "reason");
  expect(ev.applied === false && ev.task_id === null, "must not be applied");
});

await report.check("GH6", "a task on a locked project is skipped with a work_event.skipped audit row", async () => {
  const locked = await must(
    db.from("projects").insert({ workspace_id: fx.workspaceId, code: `LK-${tag.slice(-4).toUpperCase()}`, name: `Locked ${tag}`, owner_id: fx.admin.id }).select("id").single(),
    "project",
  );
  const t = await newLinkedTask(3, locked.id);
  await pgc.query("update projects set is_locked = true, locked_at = now(), locked_by_actor_type = 'user', locked_by_actor_id = $2, locked_by_label = 'probe' where id = $1", [locked.id, fx.admin.id]);
  const r = await deliver("pull_request", pr("opened", 3));
  expectEqual(r.status, 200, "delivery");
  expectEqual((await taskRow(t.id)).status_type, "backlog", "locked project's task must not move");
  const audit = await auditFor(t.id);
  expect(audit.some((a) => a.action === "work_event.skipped"), "expected a work_event.skipped audit row");
  expect(!audit.some((a) => a.action === "task.update"), "no task.update row for a skipped task");
});

await report.check("GH7", "pausing the connector refuses deliveries (kill switch); revoking frees the slot", async () => {
  const p = await call("PATCH", "/api/integrations/github/connector", { cookie: adminCookie, body: { status: "paused" } });
  expectEqual(p.status, 200, "pause");
  expectEqual((await deliver("pull_request", pr("opened", 1))).status, 401, "paused connector");
  expectEqual((await call("PATCH", "/api/integrations/github/connector", { cookie: adminCookie, body: { status: "active" } })).status, 200, "resume");
  expectEqual((await call("DELETE", "/api/integrations/github/connector", { cookie: adminCookie })).status, 200, "revoke");
  expectEqual((await deliver("pull_request", pr("opened", 1))).status, 401, "revoked connector");
});

const allPassed = report.finish();
await close();
process.exit(allPassed ? 0 : 1);
