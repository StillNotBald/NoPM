// NoPM local-DB probe — the four unattended / trigger-driven writers audit in ONE transaction (R-165, migration 0110).
//
// Proves against a LOCAL stack and a LOCAL app (guard.mjs refuses anything else):
//   J1  snapshots: the nightly cron twice -> one snapshot per project, then none; ONE snapshot.taken row per
//       run for the workspace (system actor), never one per project
//   J2  weekly report: the scheduled cron twice on the workspace's chosen day -> one report, one claim per
//       admin and manager, one audit row, one notification each; the replay changes nothing
//   J3  overspend: an expense crossing 90% then 100% -> one budget.overspend row per crossing (caller actor),
//       the level marker moves with it, an expense that crosses nothing writes nothing
//   J4  clash detection: two overlapping allocations over 100% -> one clash and ONE clash.auto_detected row;
//       dropping back under 100% -> the clash resolves with ONE clash.auto_resolve row (caller actor)
//   J5  the database functions refuse the browser roles (anon key) and a foreign workspace id
//
//   cd web && CRON_SECRET=<the secret the local app was started with> node scripts/local-db/probe-atomic-jobs.mjs
//   (the app must run on :3000 against the same local stack; default CRON_SECRET: local-uat-only)
//
// Exit codes: 0 all PASS · 1 at least one FAIL · 2 guard refused · 3 stack or app down.
import "./guard.mjs";
import { stack } from "./guard.mjs";
import { randomUUID } from "node:crypto";
import { call, requireApp } from "./app-client.mjs";
import { createReport, expect, expectEqual } from "./report.mjs";
import { connect, createFixtures, mintToken, must } from "./fixtures.mjs";

const CRON = process.env.CRON_SECRET || "local-uat-only";
const cron = (path) => call("GET", path, { token: CRON });

await requireApp();
const { db, pgc, close } = await connect();
const report = createReport("atomic unattended jobs (R-165)");
const fx = await createFixtures({ db });
const ws = fx.workspaceId;
console.log(`[fixtures] workspace=${ws} project=${fx.project.id}`);

const jobToken = await mintToken(db, {
  workspaceId: ws,
  name: "probe jobs",
  createdBy: fx.admin.id,
  scopes: ["project:read", "budget:read", "budget:write", "resource:read", "resource:write", "audit:read"],
});

const q = async (sql, params = []) => (await pgc.query(sql, params)).rows;
const count = async (sql, params = []) => Number((await q(sql, params))[0].n);
const auditRows = (action, sinceId = 0) =>
  q(
    `select actor_type, actor_id, actor_label, principal_id, target_id, before, after
       from audit_log where workspace_id = $1 and action = $2 order by chain_seq`,
    [ws, action],
  ).then((rows) => rows.slice(sinceId));

// ── J1 snapshots ───────────────────────────────────────────────────────────
await report.check("J1a", "snapshot cron, first run: one snapshot for the project and ONE snapshot.taken row", async () => {
  const res = await cron("/api/cron/snapshots");
  expectEqual(res.status, 200, `cron answered ${res.status}: ${res.text.slice(0, 200)}`);
  expectEqual(await count(`select count(*) n from project_snapshots where workspace_id = $1`, [ws]), 1, "snapshot rows");
  const rows = await auditRows("snapshot.taken");
  expectEqual(rows.length, 1, "one audit row for the run, not one per project");
  expectEqual(rows[0].actor_label, "system:snapshots", "system actor label");
  expectEqual(rows[0].actor_id, "00000000-0000-0000-0000-000000000000", "system actor id");
  expectEqual(rows[0].principal_id, null, "no human principal");
  expect(rows[0].after.taken === 1 && rows[0].after.already_taken === 0 && rows[0].after.projects === 1, `payload ${JSON.stringify(rows[0].after)}`);
});
await report.check("J1b", "snapshot cron, second run the same day: no new snapshot, one more run-level audit row", async () => {
  const res = await cron("/api/cron/snapshots");
  expectEqual(res.status, 200, "second run status");
  expectEqual(await count(`select count(*) n from project_snapshots where workspace_id = $1`, [ws]), 1, "still one snapshot");
  const rows = await auditRows("snapshot.taken");
  expectEqual(rows.length, 2, "the replay is visible as its own row");
  expect(rows[1].after.taken === 0 && rows[1].after.already_taken === 1, `payload ${JSON.stringify(rows[1].after)}`);
});

// ── J2 weekly report ───────────────────────────────────────────────────────
await report.check("J2a", "weekly report, scheduled cron twice on the chosen day: one report, one claim each, one audit row", async () => {
  const zone = (await q(`select time_zone from workspaces where id = $1`, [ws]))[0].time_zone || "Asia/Kuala_Lumpur";
  const name = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: zone }).format(new Date());
  const iso = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[name];
  await must(db.from("workspaces").update({ weekly_report_day: iso, weekly_report_enabled: true }).eq("id", ws), "set report day");
  const first = await cron("/api/integrations/cron");
  expectEqual(first.status, 200, `cron answered ${first.status}: ${first.text.slice(0, 200)}`);
  const second = await cron("/api/integrations/cron");
  expectEqual(second.status, 200, "second cron status");
  expectEqual(await count(`select count(*) n from weekly_reports where workspace_id = $1`, [ws]), 1, "one stored report");
  expectEqual(await count(`select count(*) n from nudge_log where workspace_id = $1 and kind = 'weekly_report'`, [ws]), 4, "one claim per admin and manager");
  expectEqual(await count(`select count(*) n from notifications where workspace_id = $1 and type = 'report.weekly'`, [ws]), 4, "one notification each");
  const rows = await auditRows("report.weekly.generated");
  expectEqual(rows.length, 1, "ONE audit row for two cron runs");
  expectEqual(rows[0].actor_label, "system:weekly-report", "system actor label");
  expect(rows[0].after.trigger === "scheduled" && rows[0].after.recipients === 4, `payload ${JSON.stringify(rows[0].after)}`);
});

// ── J3 overspend ───────────────────────────────────────────────────────────
const budgetUrl = `/api/projects/${fx.project.id}/budget`;
const expenseUrl = `/api/projects/${fx.project.id}/expenses`;
const spend = (amount) =>
  call("POST", expenseUrl, { token: jobToken.raw, headers: { "idempotency-key": randomUUID() }, body: { description: `probe ${amount}`, amount } });
await report.check("J3", "overspend: each crossing writes ONE budget.overspend row with its marker; a non-crossing expense writes none", async () => {
  const put = await call("PUT", budgetUrl, { token: jobToken.raw, body: { planned_amount: 1000 } });
  expect(put.status < 300, `budget upsert answered ${put.status}: ${put.text.slice(0, 200)}`);
  const level = async () => (await q(`select overspend_level l from project_budget where project_id = $1`, [fx.project.id]))[0]?.l;
  expectEqual((await spend(950)).status < 300, true, "expense 950 accepted");
  expectEqual(await level(), "warn", "marker after 950 of 1000");
  expectEqual((await spend(10)).status < 300, true, "expense 10 accepted");
  expectEqual(await level(), "warn", "marker unchanged");
  expectEqual((await spend(100)).status < 300, true, "expense 100 accepted");
  expectEqual(await level(), "over", "marker after 1060 of 1000");
  const rows = await auditRows("budget.overspend");
  expectEqual(rows.length, 2, "one row per crossing");
  expect(rows[0].before.level === "ok" && rows[0].after.level === "warn", `first ${JSON.stringify(rows[0])}`);
  expect(rows[1].before.level === "warn" && rows[1].after.level === "over" && rows[1].after.actual === 1060, `second ${JSON.stringify(rows[1])}`);
  expectEqual(rows[0].actor_type, "token", "the caller (the PAT) is the actor");
  expectEqual(rows[0].actor_id, jobToken.id, "actor id is the PAT, not the system");
});

// ── J4 clash detection ─────────────────────────────────────────────────────
await report.check("J4", "clash: over 100% -> ONE clash + ONE auto_detected row; back under -> resolved + ONE auto_resolve row", async () => {
  const alloc = (pct) =>
    call("POST", "/api/allocations", {
      token: jobToken.raw,
      body: { member_id: fx.admin.memberId, project_id: fx.project.id, allocation_pct: pct, window_start: "2030-01-01T00:00:00.000Z", window_end: "2030-06-01T00:00:00.000Z" },
    });
  const a1 = await alloc(80);
  expect(a1.status < 300, `allocation 1 answered ${a1.status}: ${a1.text.slice(0, 200)}`);
  const a2 = await alloc(60);
  expect(a2.status < 300, `allocation 2 answered ${a2.status}: ${a2.text.slice(0, 200)}`);
  const live = await q(`select id, status from clashes where workspace_id = $1 and resource_member_id = $2`, [ws, fx.admin.memberId]);
  expectEqual(live.length, 1, "one clash");
  expectEqual(live[0].status, "open", "clash is open");
  const detected = await auditRows("clash.auto_detected");
  expectEqual(detected.length, 1, "ONE auto_detected row");
  expectEqual(detected[0].actor_id, jobToken.id, "the caller is the actor");
  expectEqual(detected[0].target_id, live[0].id, "audit targets the clash");
  const id = a2.json?.data?.id;
  expect(id, "allocation 2 id");
  const patch = await call("PATCH", `/api/allocations/${id}`, { token: jobToken.raw, body: { allocation_pct: 10 } });
  expect(patch.status < 300, `allocation patch answered ${patch.status}: ${patch.text.slice(0, 200)}`);
  expectEqual((await q(`select status from clashes where id = $1`, [live[0].id]))[0].status, "resolved", "clash resolved");
  const resolved = await auditRows("clash.auto_resolve");
  expectEqual(resolved.length, 1, "ONE auto_resolve row");
  expectEqual(resolved[0].actor_id, jobToken.id, "the caller is the actor of the resolve");
  expect(resolved[0].before.status === "open" && resolved[0].after.status === "resolved", `payload ${JSON.stringify(resolved[0])}`);
});

// ── J5 the functions are not reachable from the browser roles, and are workspace-bound ──────────
await report.check("J5a", "the anon key cannot call the four functions", async () => {
  if (!stack.anonKey) throw new Error("no anon key in the stack env");
  for (const fn of ["nopm_clash_auto_resolve", "nopm_overspend_cross", "nopm_snapshot_run", "nopm_weekly_report_store"]) {
    const res = await fetch(`${stack.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: stack.anonKey, authorization: `Bearer ${stack.anonKey}`, "content-type": "application/json" },
      body: "{}",
    });
    expect([401, 403, 404].includes(res.status), `${fn}: anon answered ${res.status}`);
  }
});
await report.check("J5b", "a foreign workspace id changes nothing: resolve returns null, overspend returns false", async () => {
  const other = await must(db.from("workspaces").insert({ name: `Other ${fx.tag}`, slug: `other-${fx.tag}` }).select("id").single(), "other workspace");
  const clash = await must(
    db.from("clashes").insert({ workspace_id: ws, title: "j5", type: "resource", severity: "low", status: "open" }).select("id").single(),
    "clash",
  );
  const audit = { action: "clash.auto_resolve", target_type: "clash", actor_type: "token", actor_id: jobToken.id, actor_label: "probe", channel: "api" };
  const res = await db.rpc("nopm_clash_auto_resolve", { p_workspace_id: other.id, p_clash_id: clash.id, p_audit: audit });
  expect(!res.error && res.data === null, `resolve with a foreign workspace: ${JSON.stringify(res)}`);
  expectEqual((await q(`select status from clashes where id = $1`, [clash.id]))[0].status, "open", "clash untouched");
  const cross = await db.rpc("nopm_overspend_cross", {
    p_workspace_id: other.id, p_project_id: fx.project.id, p_previous: "over", p_next: "ok",
    p_audit: { ...audit, action: "budget.overspend", target_type: "project_budget" }, p_after: {},
  });
  expect(!cross.error && cross.data === false, `overspend with a foreign workspace: ${JSON.stringify(cross)}`);
  expectEqual((await q(`select overspend_level l from project_budget where project_id = $1`, [fx.project.id]))[0].l, "over", "marker untouched");
});

const allPassed = report.finish();
await close();
process.exit(allPassed ? 0 : 1);
