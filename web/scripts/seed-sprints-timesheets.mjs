// NoPM — seed sprints (2 closed + 1 active, with a real burndown history).
// Idempotent: purges its own artifacts, then re-inserts. Modeled on
// seed-approvals.mjs / seed-change-control.mjs's style (env parsing, admin
// client, purge-first).
//
// Hour logging and weekly timesheets were removed from the product (owner
// decision 18, 2026-10-17): this script NO LONGER creates time_entries or
// timesheet_submissions, and it does not purge any (the tables and their
// rows are kept as-is). The filename is kept so `seed:all` and setup.mjs
// need no change.
//
// Respects the project-lock backstop (migration 20260814000028): the
// only schedule-shape write here is attaching tasks to the active sprint
// via tasks.sprint_id, which is NOT one of that trigger's guarded columns
// (SCHEDULE_SHAPE_TASK_FIELDS — start_date/due_date/baseline_*/
// estimate_hours/milestone_id/project_id), so it is unaffected regardless
// of whether the target project happens to be locked. We still deliberately
// use CDP-CORE (never locked by seed-mainline-deps.mjs, which only locks
// ERP-EMEA) so this script has no dependency on lock state or run order
// relative to that script at all.
//
// Prerequisites: seed.mjs, seed-members.mjs.
//
// Wired into `npm run seed:all` as the final step (see package.json) since
// the sibling seeds are chained; can also be run standalone:
//   node scripts/seed-sprints-timesheets.mjs
// DO NOT run automatically — the orchestrator runs this after review.

import { createClient } from "@supabase/supabase-js";
import { addDays, workingDaysInRange, evenlySpaced } from "./lib/working-days.mjs";
import { loadEnv, requireEnv } from "./lib/env.mjs";

const env = requireEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], loadEnv());
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ins = async (table, row) => {
  const { data, error } = await db.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
};

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
const profiles = (await db.from("profiles").select("id, display_name, role, email").eq("workspace_id", W)).data ?? [];
const admin = profiles.find((p) => p.role === "admin");
if (!admin) throw new Error("No admin profile found (run seed-members.mjs first)");

console.log(`people: admin=${admin.display_name}`);

// ── project ──────────────────────────────────────────────────────────────
// CDP-CORE deliberately, not ERP-EMEA: seed-mainline-deps.mjs locks
// ERP-EMEA as the last step of `npm run seed:all`, and while sprint_id
// attachment is unaffected by that lock either way (see header note), using
// an always-unlocked project keeps this script's dependencies simple.
const project = (await db.from("projects").select("id, name, code").eq("workspace_id", W).eq("code", "CDP-CORE").single()).data;
if (!project) throw new Error("CDP-CORE project not found (run seed.mjs first)");
console.log("project:", project.code, "-", project.name);

// ── purge previous seed artifacts (sprints) ───────────────────────────────
console.log("purging previous seed artifacts...");
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


