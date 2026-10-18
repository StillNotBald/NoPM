// NoPM — seed task_dependencies (mainline DAG + critical path) and stagger project timelines.
// Idempotent: clears existing task_dependencies for the demo workspace, then re-inserts.
// ADDITIVE updates only for projects / milestones / tasks (no delete/reinsert — IDs preserved).
//
// Usage: node scripts/seed-mainline-deps.mjs
// DO NOT run automatically — the orchestrator runs this after review.

import { createClient } from "@supabase/supabase-js";
import { loadEnv, requireEnv } from "./lib/env.mjs";

// ── Connection ────────────────────────────────────────────────────────────────
const env = requireEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], loadEnv());
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Add N days to a date string "YYYY-MM-DD" and return the same format. */
function shiftDate(dateStr, days) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Throw on Supabase error. */
function assertOk(label, error) {
  if (error) throw new Error(`${label}: ${error.message}`);
}

// ── Resolve demo workspace ────────────────────────────────────────────────────
const { data: ws, error: wsErr } = await db
  .from("workspaces")
  .select("id")
  .eq("slug", "demo")
  .single();
assertOk("workspace lookup", wsErr);
if (!ws) { console.error("demo workspace not found"); process.exit(1); }
const W = ws.id;
console.log("workspace:", W);

// ── Step 1: clear existing task_dependencies for the demo workspace ───────────
const { error: delErr } = await db
  .from("task_dependencies")
  .delete()
  .eq("workspace_id", W);
assertOk("delete task_dependencies", delErr);
console.log("cleared existing task_dependencies");

// ── Step 2: load projects in creation order ───────────────────────────────────
const { data: projects, error: projErr } = await db
  .from("projects")
  .select("id, code, start_date, target_date, baseline_start_date, baseline_target_date")
  .eq("workspace_id", W)
  .order("created_at", { ascending: true });
assertOk("projects fetch", projErr);
console.log(`found ${projects.length} project(s)`);

// ── Step 3: stagger project timelines ────────────────────────────────────────
// Each project is offset by projectIndex * 35 days from its original dates.
// We UPDATE projects, milestones, and tasks additively (no delete/reinsert).

const STAGGER_DAYS = 35;
let projectRowsUpdated = 0;
let milestoneRowsUpdated = 0;
let taskRowsUpdated = 0;

// Stagger is OFF by default: it shifts completed projects into the future
// (incoherent with their past actual_date / "complete" status). Re-enable with
// STAGGER=1 once it's reworked to spread only non-complete projects coherently
// (planned for the Mainline-UI wave). Dependency seeding (below) always runs.
const DO_STAGGER = process.env.STAGGER === "1";
for (const [pi, proj] of (DO_STAGGER ? projects.entries() : [])) {
  const offset = pi * STAGGER_DAYS;
  if (offset === 0) continue; // first project stays as-is

  // -- Update project dates --
  const newProjStart  = shiftDate(proj.start_date, offset);
  const newProjTarget = shiftDate(proj.target_date, offset);
  const newProjBaseStart  = shiftDate(proj.baseline_start_date, offset);
  const newProjBaseTarget = shiftDate(proj.baseline_target_date, offset);

  const { error: projUpdateErr } = await db
    .from("projects")
    .update({
      start_date:           newProjStart,
      target_date:          newProjTarget,
      baseline_start_date:  newProjBaseStart,
      baseline_target_date: newProjBaseTarget,
    })
    .eq("id", proj.id);
  assertOk(`project update (${proj.code})`, projUpdateErr);
  projectRowsUpdated++;

  // -- Update milestones for this project --
  const { data: milestones, error: msErr } = await db
    .from("milestones")
    .select("id, start_date, target_date, baseline_target_date")
    .eq("project_id", proj.id);
  assertOk(`milestones fetch (${proj.code})`, msErr);

  for (const ms of milestones ?? []) {
    const { error: msUpdateErr } = await db
      .from("milestones")
      .update({
        start_date:           shiftDate(ms.start_date, offset),
        target_date:          shiftDate(ms.target_date, offset),
        baseline_target_date: shiftDate(ms.baseline_target_date, offset),
      })
      .eq("id", ms.id);
    assertOk(`milestone update (${ms.id})`, msUpdateErr);
    milestoneRowsUpdated++;
  }

  // -- Update tasks for this project --
  const { data: tasks, error: tasksErr } = await db
    .from("tasks")
    .select("id, start_date, due_date")
    .eq("project_id", proj.id);
  assertOk(`tasks fetch (${proj.code})`, tasksErr);

  for (const t of tasks ?? []) {
    const newStart = shiftDate(t.start_date, offset);
    const newDue   = shiftDate(t.due_date, offset);

    // Keep start < due; if both null that's fine too.
    const { error: tUpdateErr } = await db
      .from("tasks")
      .update({ start_date: newStart, due_date: newDue })
      .eq("id", t.id);
    assertOk(`task date update (${t.id})`, tUpdateErr);
    taskRowsUpdated++;
  }
}

console.log(
  `staggered: ${projectRowsUpdated} project(s), ${milestoneRowsUpdated} milestone(s), ${taskRowsUpdated} task(s) updated`,
);

// ── Step 4: build the mainline DAG ────────────────────────────────────────────
// For each project:
//   a) Order milestones by sort_order (matches the seeded order: Discovery → Build → Cutover).
//   b) Within each milestone, order tasks by sort_order (the seeded insertion order).
//   c) Chain tasks within a milestone: task[i] FS→ task[i+1].
//   d) Cross-milestone chain: last task of milestone[m] FS→ first task of milestone[m+1].
//   e) Set tasks.blocked_by to the immediate predecessor (where it adds meaning — we set it
//      for every task that has a predecessor in this script, not just "blocked"-labelled ones,
//      mirroring how the seed.mjs approach worked but now driven by the real DAG).
//
// This yields one clear longest critical path per project:
//   Discovery[0] → … → Discovery[last] → Build[0] → … → Build[last] → Cutover[0] → … → Cutover[last]

const depsToInsert = [];
let blockedByUpdates = 0;

for (const proj of projects) {
  // Fetch milestones sorted by sort_order
  const { data: milestones, error: msErr } = await db
    .from("milestones")
    .select("id, name, sort_order")
    .eq("project_id", proj.id)
    .order("sort_order", { ascending: true });
  assertOk(`milestones for DAG (${proj.code})`, msErr);

  const milestoneChain = []; // array of { milestoneId, orderedTasks: [{id}] }

  for (const ms of milestones ?? []) {
    const { data: tasks, error: tErr } = await db
      .from("tasks")
      .select("id, sort_order")
      .eq("milestone_id", ms.id)
      .eq("workspace_id", W)
      .order("sort_order", { ascending: true });
    assertOk(`tasks for milestone (${ms.id})`, tErr);

    if (!tasks || tasks.length === 0) continue;
    milestoneChain.push({ milestoneId: ms.id, milestoneName: ms.name, orderedTasks: tasks });
  }

  // Track the last task of the previous milestone for cross-milestone edges
  let prevMilestoneLast = null;

  for (const { orderedTasks } of milestoneChain) {
    // Cross-milestone edge: last of previous → first of this milestone
    if (prevMilestoneLast) {
      const firstTask = orderedTasks[0];
      depsToInsert.push({
        workspace_id:   W,
        predecessor_id: prevMilestoneLast.id,
        successor_id:   firstTask.id,
        type:           "FS",
        lag_days:       0,
      });

      // Update blocked_by on the first task of this milestone
      const { error: bErr } = await db
        .from("tasks")
        .update({ blocked_by: prevMilestoneLast.id })
        .eq("id", firstTask.id);
      assertOk(`blocked_by cross-milestone (${firstTask.id})`, bErr);
      blockedByUpdates++;
    }

    // Within-milestone chain
    for (let i = 0; i < orderedTasks.length - 1; i++) {
      const pred = orderedTasks[i];
      const succ = orderedTasks[i + 1];
      depsToInsert.push({
        workspace_id:   W,
        predecessor_id: pred.id,
        successor_id:   succ.id,
        type:           "FS",
        lag_days:       0,
      });

      // Set blocked_by on the successor
      const { error: bErr } = await db
        .from("tasks")
        .update({ blocked_by: pred.id })
        .eq("id", succ.id);
      assertOk(`blocked_by intra-milestone (${succ.id})`, bErr);
      blockedByUpdates++;
    }

    prevMilestoneLast = orderedTasks[orderedTasks.length - 1];
  }
}

console.log(`dependency rows to insert: ${depsToInsert.length}`);

// ── Step 5: insert dependencies in batches of 100 ────────────────────────────
// The unique constraint (predecessor_id, successor_id) guards against dupes.
// Since we deleted all deps for this workspace first, there are no conflicts.

const BATCH_SIZE = 100;
let depsInserted = 0;

for (let i = 0; i < depsToInsert.length; i += BATCH_SIZE) {
  const batch = depsToInsert.slice(i, i + BATCH_SIZE);
  const { error: insErr } = await db
    .from("task_dependencies")
    .insert(batch);
  assertOk(`insert task_dependencies batch at ${i}`, insErr);
  depsInserted += batch.length;
}

// ── Step 6: lock ERP-EMEA now that every child row is in place ────────────────
// seed.mjs deliberately creates ERP-EMEA UNLOCKED (see its comment there) so
// every seed script that writes its milestones/tasks/task_dependencies —
// including this one, above — can do so before the DB-level project-lock
// backstop (migration 20260814000028) starts enforcing. This script is the
// last step of `npm run seed:all`, so locking here is the correct "seed
// children, then lock last" point. Values mirror what seed.mjs used to set
// at creation time.
// Migration 0088 (projects_lock_integrity): a lock must carry locked_at and a locker.
const { data: lockerRows } = await db
  .from("profiles")
  .select("id, display_name, email, role")
  .eq("workspace_id", W)
  .order("role", { ascending: true }); // 'admin' sorts first
const locker = (lockerRows ?? []).find((p) => p.role === "admin") ?? (lockerRows ?? [])[0];
if (!locker) throw new Error("lock ERP-EMEA: no profile in the demo workspace to record as the locker");
const { error: lockErr } = await db
  .from("projects")
  .update({
    is_locked: true,
    lock_reason: "Baseline frozen for steerco",
    locked_at: new Date().toISOString(),
    locked_by: locker.id,
    locked_by_actor_type: "user",
    locked_by_actor_id: locker.id,
    locked_by_label: locker.display_name ?? locker.email ?? "seed admin",
  })
  .eq("workspace_id", W)
  .eq("code", "ERP-EMEA");
assertOk("lock ERP-EMEA", lockErr);
console.log("locked ERP-EMEA (Baseline frozen for steerco)");

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n✓ seed-mainline-deps complete");
console.log(`  task_dependencies inserted : ${depsInserted}`);
console.log(`  tasks.blocked_by updated   : ${blockedByUpdates}`);
console.log(`  projects staggered         : ${projectRowsUpdated} (offset 35 days × project index)`);
console.log(`  milestones date-shifted    : ${milestoneRowsUpdated}`);
console.log(`  tasks date-shifted         : ${taskRowsUpdated}`);
console.log("\nDependency chain per project (critical path):");
console.log("  Discovery[0] →FS→ … →FS→ Discovery[last]");
console.log("                              ↓ FS (cross-milestone)");
console.log("  Build[0]     →FS→ … →FS→ Build[last]");
console.log("                              ↓ FS (cross-milestone)");
console.log("  Cutover[0]   →FS→ … →FS→ Cutover[last]");
console.log("\ntask_dependencies columns used:");
console.log("  workspace_id, predecessor_id, successor_id, type ('FS'), lag_days (0)");
