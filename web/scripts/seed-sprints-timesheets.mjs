// NoPM — seed sprints (2 closed + 1 active, with a real burndown history)
// and timesheet four-eyes demo data (F2c-mini T2, extends R-52). Idempotent:
// purges its own artifacts, then re-inserts. Modeled on seed-approvals.mjs /
// seed-change-control.mjs's style (env parsing, admin client, purge-first).
//
// ORDERING — read before touching this file. Migration 20260815000040 (the
// period-close lock DB trigger, T1/R-76) rejects INSERT/DELETE on
// time_entries for any (member, date) covered by an APPROVED
// timesheet_submission, with NO bypass GUC (unlike the project-lock
// backstop). That means:
//   1. PURGE must delete timesheet_submissions BEFORE time_entries. If an
//      approved submission from a prior run is still present when we try to
//      delete its week's entries, the trigger rejects the delete with
//      PERIOD_LOCKED and this script aborts. Deleting the submission first
//      drops the lock, so the entries underneath it can then be cleared.
//   2. (RE)SEED must insert every time_entries row for a week BEFORE that
//      week's timesheet_submissions row is inserted with status='approved'.
//      This script satisfies that trivially by running ALL time-entry
//      inserts (phase A) before ANY timesheet_submissions insert (phase B)
//      — no interleaving, so there's nothing to get wrong here as long as
//      that phase order is preserved.
// Both are enforced by the ordering of the code below, not by a guard —
// keep the phase order if you edit this file.
//
// Also respects the project-lock backstop (migration 20260814000028): the
// only schedule-shape write here is attaching tasks to the active sprint
// via tasks.sprint_id, which is NOT one of that trigger's guarded columns
// (SCHEDULE_SHAPE_TASK_FIELDS — start_date/due_date/baseline_*/
// estimate_hours/milestone_id/project_id), so it is unaffected regardless
// of whether the target project happens to be locked. We still deliberately
// use CDP-CORE (never locked by seed-mainline-deps.mjs, which only locks
// ERP-EMEA) so this script has no dependency on lock state or run order
// relative to that script at all.
//
// Prerequisites: seed.mjs, seed-members.mjs, seed-people-link.mjs (Priya
// Nair / Daniel Okoro must already be linked profile<->resource_member —
// see the four-eyes identity note below).
//
// Wired into `npm run seed:all` as the final step (see package.json) since
// the sibling seeds are chained; can also be run standalone:
//   node scripts/seed-sprints-timesheets.mjs
// DO NOT run automatically — the orchestrator runs this after review.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addDays, mondayOf, workingDaysInRange, evenlySpaced } from "./lib/working-days.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(here, "..", ".env.local"), "utf8")
    .split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ins = async (table, row) => {
  const { data, error } = await db.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
};

// Tags every row this script owns so purge can find exactly (and only) its
// own artifacts without touching other scripts' data (e.g. seed.mjs's own
// one-row-per-project time_entries seed, which can land on the same
// members by index).
const SEED_NOTE_TAG = "Seed(sprints-timesheets)";

// ── workspace ────────────────────────────────────────────────────────────
// NOPM_WORKSPACE_ID is written by scripts/bootstrap.mjs; fall back to the
// 'demo' slug lookup every sibling script uses in case bootstrap hasn't run
// in this environment yet.
const W = env.NOPM_WORKSPACE_ID
  ?? (await db.from("workspaces").select("id").eq("slug", "demo").single()).data?.id;
if (!W) throw new Error("No workspace resolved (set NOPM_WORKSPACE_ID or seed the 'demo' workspace first)");
console.log("workspace:", W);

const today = new Date().toISOString().slice(0, 10);

// ── people ───────────────────────────────────────────────────────────────
// Four-eyes identity (recon-foureyes.md / migration 0038 header): submitted_by
// / decided_by are LOGIN identities (profiles.id), never resource_members.id.
// "submitter != demo admin" per T2's spec means submitted_by must not be the
// workspace admin's profile id, so the admin can decide the pending one live
// without tripping ts_maker_checker / the route's self-decision guard.
const profiles = (await db.from("profiles").select("id, display_name, role, email").eq("workspace_id", W)).data ?? [];
const admin = profiles.find((p) => p.role === "admin");
if (!admin) throw new Error("No admin profile found (run seed-members.mjs first)");

const priyaProfile = profiles.find((p) => p.email === "priya.nair@stillnotbald.com");
const danielProfile = profiles.find((p) => p.email === "daniel.okoro@stillnotbald.com");
if (!priyaProfile || !danielProfile) {
  throw new Error("Priya Nair / Daniel Okoro profiles not found — run seed-members.mjs first");
}

const members = (await db.from("resource_members").select("id, name, profile_id, cost_rate").eq("workspace_id", W)).data ?? [];
const priya = members.find((m) => m.profile_id === priyaProfile.id);
const daniel = members.find((m) => m.profile_id === danielProfile.id);
if (!priya || !daniel) {
  throw new Error("Priya/Daniel resource_members not linked to their login yet — run seed-people-link.mjs first");
}
// A third member purely for time-entry variety (T2's "2-3 members" for time
// entries) — no submission of their own; only Priya/Daniel need to be
// login-linked for the three-decision submission demo. Excludes the admin's
// own resource_member (created by seed-people-link.mjs for every profile)
// so the demo stays focused on non-admin work.
const thirdMember = members.find((m) => m.id !== priya.id && m.id !== daniel.id && m.profile_id !== admin.id) ?? null;

console.log(`people: admin=${admin.display_name}; priya(member)=${priya.name}; daniel(member)=${daniel.name}; third=${thirdMember?.name ?? "(none found)"}`);

// ── project ──────────────────────────────────────────────────────────────
// CDP-CORE deliberately, not ERP-EMEA: seed-mainline-deps.mjs locks
// ERP-EMEA as the last step of `npm run seed:all`, and while sprint_id
// attachment is unaffected by that lock either way (see header note), using
// an always-unlocked project keeps this script's dependencies simple.
const project = (await db.from("projects").select("id, name, code").eq("workspace_id", W).eq("code", "CDP-CORE").single()).data;
if (!project) throw new Error("CDP-CORE project not found (run seed.mjs first)");
console.log("project:", project.code, "-", project.name);

// ── purge previous seed artifacts (submissions -> entries -> sprints) ──────
console.log("purging previous seed artifacts...");
const involvedMemberIds = [priya.id, daniel.id, thirdMember?.id].filter(Boolean);
{
  const { error } = await db.from("timesheet_submissions").delete().eq("workspace_id", W).in("member_id", involvedMemberIds);
  if (error) throw new Error(`purge timesheet_submissions: ${error.message}`);
}
{
  const { error } = await db.from("time_entries").delete().eq("workspace_id", W).like("note", `${SEED_NOTE_TAG}%`);
  if (error) throw new Error(`purge time_entries: ${error.message}`);
}
{
  // sprints is exclusively owned by this script (greenfield entity, no
  // other seed script writes it) — clearing all of them for the workspace
  // is safe. ON DELETE SET NULL on tasks.sprint_id (migration 0037) handles
  // detaching tasks automatically.
  const { error } = await db.from("sprints").delete().eq("workspace_id", W);
  if (error) throw new Error(`purge sprints: ${error.message}`);
}
console.log("purge complete");

// ── candidate tasks for sprints (real, already-seeded CDP-CORE tasks) ──────
// Ordered by created_at so the slice below reproduces seed.mjs's own
// Discovery -> Build -> Cutover insertion order deterministically.
const tasks = (
  await db.from("tasks").select("*")
    .eq("workspace_id", W).eq("project_id", project.id)
    .not("story_points", "is", null)
    .order("created_at", { ascending: true })
).data ?? [];
if (tasks.length < 15) {
  throw new Error(`CDP-CORE has only ${tasks.length} pointed tasks — need >=15 for 2 closed sprints + 1 active sprint (run seed.mjs first)`);
}

const snapshotOf = (list) => Object.fromEntries(list.map((t) => [t.id, Number(t.story_points)]));
const sumPoints = (map) => Object.values(map).reduce((a, b) => a + b, 0);

const sprint1Pool = tasks.slice(0, 5);
const sprint2Pool = tasks.slice(5, 10);
const activeCount = Math.max(5, Math.min(8, tasks.length - 10));
const activeTasks = tasks.slice(10, 10 + activeCount);

// ── sprint 1 (closed, oldest — partial completion, spillover) ──────────────
const sprint1End = addDays(today, -22);
const sprint1Start = addDays(sprint1End, -13); // 14-day sprint
const sprint1Committed = snapshotOf(sprint1Pool);
const sprint1CompletedTasks = sprint1Pool.slice(0, 4); // 1 of 5 spills over
const sprint1Completed = snapshotOf(sprint1CompletedTasks);

const sprint1 = await ins("sprints", {
  workspace_id: W, project_id: project.id,
  name: "Sprint 1 — Identity Resolution Hardening",
  goal: "Lift legacy-source match rates and burn down the leading QA defects.",
  start_date: sprint1Start, end_date: sprint1End, state: "closed",
  committed_points: sumPoints(sprint1Committed), committed_snapshot: sprint1Committed,
  completed_points: sumPoints(sprint1Completed), completed_snapshot: sprint1Completed,
  started_at: `${sprint1Start}T09:00:00Z`, closed_at: `${sprint1End}T17:00:00Z`,
});
console.log(`sprint 1 (closed): committed ${sprint1.committed_points} / completed ${sprint1.completed_points}`);

// ── sprint 2 (closed, more recent — fully delivered: improving velocity) ───
const sprint2End = addDays(sprint1Start, -1);
const sprint2Start = addDays(sprint2End, -13);
const sprint2Committed = snapshotOf(sprint2Pool);
const sprint2Completed = snapshotOf(sprint2Pool); // full delivery this time

const sprint2 = await ins("sprints", {
  workspace_id: W, project_id: project.id,
  name: "Sprint 2 — Consent-Aware Serving API",
  goal: "Ship the consent-aware CDP serving API and clear the sprint-1 spillover.",
  start_date: sprint2Start, end_date: sprint2End, state: "closed",
  committed_points: sumPoints(sprint2Committed), committed_snapshot: sprint2Committed,
  completed_points: sumPoints(sprint2Completed), completed_snapshot: sprint2Completed,
  started_at: `${sprint2Start}T09:00:00Z`, closed_at: `${sprint2End}T17:00:00Z`,
});
console.log(`sprint 2 (closed): committed ${sprint2.committed_points} / completed ${sprint2.completed_points}`);

// ── sprint 3 (active, mid-window) ───────────────────────────────────────────
const activeStart = addDays(today, -4);
const activeEnd = addDays(today, 10); // 14-day sprint, today ~ day 5
const activeCommitted = snapshotOf(activeTasks);

const sprint3 = await ins("sprints", {
  workspace_id: W, project_id: project.id,
  name: "Sprint 3 — Match-Rate Recovery (active)",
  goal: "Close the remaining identity-resolution gaps flagged in the sprint-2 retro.",
  start_date: activeStart, end_date: activeEnd, state: "active",
  committed_points: sumPoints(activeCommitted), committed_snapshot: activeCommitted,
  completed_points: null, completed_snapshot: null,
  started_at: `${activeStart}T09:00:00Z`, closed_at: null,
});
console.log(`sprint 3 (active): committed ${sprint3.committed_points}, ${activeTasks.length} tasks attached`);

{
  const { error } = await db.from("tasks").update({ sprint_id: sprint3.id }).in("id", activeTasks.map((t) => t.id));
  if (error) throw new Error(`attach active-sprint tasks: ${error.message}`);
}

// Re-fetch the attached tasks so the burndown snapshots below reflect
// current (post-attach) state rather than the stale pre-attach copy in
// `activeTasks` — the sprint attachment happened first in this narrative,
// so both the "before" and "after" of the status.completed transition
// should already show sprint_id = sprint3.id.
const { data: refreshedActiveTasks, error: refetchErr } = await db.from("tasks").select("*").in("id", activeTasks.map((t) => t.id));
if (refetchErr) throw new Error(`re-fetch active-sprint tasks: ${refetchErr.message}`);
const activeTaskById = Object.fromEntries(refreshedActiveTasks.map((t) => [t.id, t]));

// ── historical task.update audit rows (real burndown line) ────────────────
// Back-dated across the active sprint's ELAPSED working days only (never
// into the future). Full before/after task snapshots, differing only in
// status_type (T2 spec) — the live task row is updated to match the "after"
// snapshot exactly. audit_log is append-only, so this is check-before-insert
// per task rather than purge-then-reinsert: re-running the script must never
// duplicate transition history.
//
// Only tasks NOT already 'completed' are eligible: src/lib/insight/
// burndown.ts's deriveBurndown() skips any audit row where before.status_type
// === after.status_type (no genuine transition), so a task already sitting
// at 'completed' would never register in the burndown series at all if we
// "transitioned" it to the same status it's already in.
const elapsedWorkingDays = workingDaysInRange(activeStart, today);
const completableCandidates = activeTasks
  .map((t) => activeTaskById[t.id])
  .filter((t) => t.status_type !== "completed" && t.status_type !== "canceled");
const completingTasks = completableCandidates.slice(0, 3);
const burndownDays = evenlySpaced(elapsedWorkingDays, completingTasks.length);
const BURNDOWN_TIMES = ["11:20", "15:05", "17:40"];

let burndownRowsInserted = 0;
const n = Math.min(completingTasks.length, burndownDays.length);
for (let i = 0; i < n; i++) {
  const task = completingTasks[i];
  const { count, error: countErr } = await db.from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", W).eq("target_type", "task").eq("target_id", task.id).eq("action", "task.update");
  if (countErr) throw new Error(`audit_log existence check (${task.id}): ${countErr.message}`);
  if (count) {
    console.log(`  burndown row already seeded, skipping: ${task.name}`);
    continue;
  }

  const day = burndownDays[i];
  const createdAt = `${day}T${BURNDOWN_TIMES[i % BURNDOWN_TIMES.length]}:00Z`;
  const before = { ...task };
  const after = { ...task, status_type: "completed" };

  const { error: updErr } = await db.from("tasks").update({ status_type: "completed" }).eq("id", task.id);
  if (updErr) throw new Error(`task status update (${task.id}): ${updErr.message}`);

  const { error: auditErr } = await db.from("audit_log").insert({
    workspace_id: W, actor_type: "user", actor_id: admin.id, actor_label: admin.display_name,
    action: "task.update", target_type: "task", target_id: task.id,
    before, after, created_at: createdAt,
  });
  if (auditErr) throw new Error(`audit_log insert (${task.id}): ${auditErr.message}`);
  burndownRowsInserted++;
}
console.log(`burndown history: ${burndownRowsInserted} new task.update row(s) inserted (${completingTasks.length - burndownRowsInserted} already present)`);

// ── time entries (phase A — ALL entries before ANY submission, see header) ─
const lastWeekMonday = addDays(mondayOf(today), -7);
const thisWeekMonday = mondayOf(today);
// Only place "this week" entries on days that have actually happened yet.
const thisWeekOffsets = [0, 1, 2, 3, 4].filter((off) => addDays(thisWeekMonday, off) <= today).slice(0, 2);

const PRIYA_LAST_WEEK = [
  { dayOffset: 0, hours: 8, billable: true, note: "Identity-resolution matching tuning" },
  { dayOffset: 1, hours: 7.5, billable: true, note: "Legacy source cleansing pass" },
  { dayOffset: 2, hours: 6, billable: false, note: "Internal team sync + sprint planning" },
  { dayOffset: 3, hours: 8, billable: true, note: "Match-rate QA review" },
  { dayOffset: 4, hours: 5.5, billable: true, note: "Sprint review prep" },
];
const DANIEL_LAST_WEEK = [
  { dayOffset: 0, hours: 8, billable: true, note: "CDP identity-resolution defect triage" },
  { dayOffset: 1, hours: 8, billable: true, note: "Regression pass on matching rules" },
  { dayOffset: 2, hours: 8, billable: true, note: "Consent-API load-test follow-up" },
  { dayOffset: 3, hours: 6, billable: false, note: "Team retro + admin" },
  { dayOffset: 4, hours: 8, billable: true, note: "Sprint demo support" },
];
const THIS_WEEK_PLAN = [
  { hours: 7, billable: true, note: "Sprint 3 kickoff — match-rate recovery" },
  { hours: 6.5, billable: true, note: "Follow-up on sprint-2 retro actions" },
];
const THIRD_LAST_WEEK = [
  { dayOffset: 0, hours: 6, billable: true, note: "Cloud landing-zone support for CDP ingestion" },
  { dayOffset: 3, hours: 5, billable: true, note: "Ingestion pipeline pairing" },
];
const THIRD_THIS_WEEK = [
  { hours: 4, billable: true, note: "Sprint 3 support" },
];

const buildWeekRows = (member, weekMonday, plan) =>
  plan.map((e, i) => ({
    workspace_id: W, member_id: member.id, project_id: project.id,
    entry_date: addDays(weekMonday, e.dayOffset ?? thisWeekOffsets[i]),
    hours: e.hours, cost: Math.round(e.hours * (member.cost_rate ?? 0) * 100) / 100,
    billable: e.billable, note: `${SEED_NOTE_TAG}: ${e.note}`,
  }));

const insertRows = async (rows, label) => {
  if (rows.length === 0) return;
  const { error } = await db.from("time_entries").insert(rows);
  if (error) throw new Error(`time_entries (${label}): ${error.message}`);
};

const priyaLastWeekRows = buildWeekRows(priya, lastWeekMonday, PRIYA_LAST_WEEK);
const danielLastWeekRows = buildWeekRows(daniel, lastWeekMonday, DANIEL_LAST_WEEK);
const priyaThisWeekRows = buildWeekRows(priya, thisWeekMonday, THIS_WEEK_PLAN.slice(0, thisWeekOffsets.length));
const danielThisWeekRows = buildWeekRows(daniel, thisWeekMonday, THIS_WEEK_PLAN.slice(0, thisWeekOffsets.length));

await insertRows(priyaLastWeekRows, `${priya.name} last week`);
await insertRows(danielLastWeekRows, `${daniel.name} last week`);
await insertRows(priyaThisWeekRows, `${priya.name} this week`);
await insertRows(danielThisWeekRows, `${daniel.name} this week`);

if (thirdMember) {
  const thirdLastWeekRows = buildWeekRows(thirdMember, lastWeekMonday, THIRD_LAST_WEEK);
  const thirdThisWeekRows = buildWeekRows(thirdMember, thisWeekMonday, THIRD_THIS_WEEK.slice(0, thisWeekOffsets.length));
  await insertRows(thirdLastWeekRows, `${thirdMember.name} last week`);
  await insertRows(thirdThisWeekRows, `${thirdMember.name} this week`);
}
console.log(`time entries inserted: priya=${priyaLastWeekRows.length + priyaThisWeekRows.length}, daniel=${danielLastWeekRows.length + danielThisWeekRows.length}, third=${thirdMember ? "yes" : "none"}`);

const sumHours = (rows) => rows.reduce((s, r) => s + r.hours, 0);

// ── timesheet submissions (phase B — after ALL entries above) ──────────────
// Priya: last week's timesheet was rejected once, then resubmitted (same
// member+period_start — explicitly allowed per migration 0038's comment:
// "resubmission after a rejection"), and the resubmission is what's pending
// in the Review Queue for the live demo. Daniel: last week's timesheet is
// approved outright, which is what demonstrates the T1 period-close lock.
const insertSubmission = async ({ member, periodStart, rows, status, submittedByProfile, submittedAt, decided }) => {
  const row = {
    workspace_id: W, member_id: member.id,
    period_start: periodStart, period_end: addDays(periodStart, 6),
    hours_total: sumHours(rows), entry_count: rows.length,
    status, submitted_by: submittedByProfile.id, submitted_by_type: "user",
    submitted_by_label: submittedByProfile.display_name, submitted_at: submittedAt,
    decided_by: decided?.by.id ?? null,
    decided_by_type: decided ? "user" : null,
    decided_by_label: decided?.by.display_name ?? null,
    decided_at: decided?.at ?? null,
    decision_rationale: decided?.rationale ?? null,
  };
  const { error } = await db.from("timesheet_submissions").insert(row);
  if (error) throw new Error(`timesheet_submissions (${member.name} ${periodStart} ${status}): ${error.message}`);
};

const rejectedSubmittedAt = `${addDays(lastWeekMonday, 6)}T18:00:00Z`;
const resubmittedAt = `${addDays(lastWeekMonday, 7)}T14:00:00Z`;
const danielSubmittedAt = `${addDays(lastWeekMonday, 6)}T17:30:00Z`;
const adminDecidesAt = `${addDays(lastWeekMonday, 7)}T10:15:00Z`;

await insertSubmission({
  member: priya, periodStart: lastWeekMonday, rows: priyaLastWeekRows, status: "rejected",
  submittedByProfile: priyaProfile, submittedAt: rejectedSubmittedAt,
  decided: {
    by: admin, at: `${addDays(lastWeekMonday, 7)}T09:30:00Z`,
    rationale: "Hours look high for a mid-sprint week without a matching sprint note on the Tuesday sync block — please split it out and resubmit.",
  },
});
await insertSubmission({
  member: priya, periodStart: lastWeekMonday, rows: priyaLastWeekRows, status: "submitted",
  submittedByProfile: priyaProfile, submittedAt: resubmittedAt,
});
await insertSubmission({
  member: daniel, periodStart: lastWeekMonday, rows: danielLastWeekRows, status: "approved",
  submittedByProfile: danielProfile, submittedAt: danielSubmittedAt,
  decided: { by: admin, at: adminDecidesAt, rationale: "Hours reconcile against sprint capacity — approved." },
});
console.log("timesheet_submissions: 1 rejected (Priya) + 1 submitted/pending (Priya, resubmission) + 1 approved (Daniel, locks that week)");

console.log("\n✓ seed-sprints-timesheets complete.");
console.log(`  sprints: ${sprint1.name} (closed) / ${sprint2.name} (closed) / ${sprint3.name} (active, ${activeTasks.length} tasks)`);
console.log(`  burndown: ${completingTasks.length} tasks marked completed across ${n} back-dated working day(s)`);
console.log("  timesheets: Priya Nair (rejected -> resubmitted/pending), Daniel Okoro (approved -> locks last week)");
