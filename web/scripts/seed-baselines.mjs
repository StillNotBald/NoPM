// One-off: seed baseline dates on milestones and tasks in the 'demo' workspace
// so the Gantt shows visible slip for a subset and on-baseline for the rest.
// Idempotent: only writes rows where baseline is still null (same rule as the
// lock handler) — re-running after a lock will skip already-baselined rows.
// DO NOT run this automatically; invoke manually: node scripts/seed-baselines.mjs
import { createClient } from "@supabase/supabase-js";
import { loadEnv, requireEnv } from "./lib/env.mjs";

const env = requireEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], loadEnv());
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Resolve the 'demo' workspace id.
const { data: ws, error: wsErr } = await db
  .from("workspaces")
  .select("id")
  .eq("slug", "demo")
  .single();
if (wsErr || !ws) { console.error("demo workspace not found:", wsErr); process.exit(1); }
const W = ws.id;

// Helper: offset a date string by N days (positive = later, negative = earlier).
function offsetDate(dateStr, days) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ── 1. Milestones ──────────────────────────────────────────────────────────
// Fetch milestones in the demo workspace that have no baseline yet.
const { data: milestones, error: msErr } = await db
  .from("milestones")
  .select("id, target_date, sort_order")
  .eq("workspace_id", W)
  .is("baseline_target_date", null)
  .order("sort_order");

if (msErr) { console.error("milestones fetch failed:", msErr); process.exit(1); }

let msBaselined = 0;
let msSlipped    = 0;

for (let i = 0; i < milestones.length; i++) {
  const ms = milestones[i];
  if (!ms.target_date) continue; // nothing to baseline

  // Alternate: even-index milestones show slip (baseline was 7 days earlier than
  // current), odd-index milestones are on-baseline (same dates).
  const offset = i % 2 === 0 ? -7 : 0;
  const baseline = offsetDate(ms.target_date, offset);

  const { error } = await db
    .from("milestones")
    .update({ baseline_target_date: baseline })
    .eq("id", ms.id)
    .eq("workspace_id", W);

  if (error) { console.error(`milestone ${ms.id} update failed:`, error); continue; }
  if (offset !== 0) msSlipped++; else msBaselined++;
}

console.log(`milestones: ${msBaselined} on-baseline, ${msSlipped} showing slip (baseline 7d earlier)`);

// ── 2. Tasks ───────────────────────────────────────────────────────────────
// Fetch tasks in the demo workspace that have no baseline yet.
const { data: tasks, error: tasksErr } = await db
  .from("tasks")
  .select("id, start_date, due_date, sort_order")
  .eq("workspace_id", W)
  .is("baseline_start_date", null)
  .is("baseline_due_date", null)
  .order("sort_order");

if (tasksErr) { console.error("tasks fetch failed:", tasksErr); process.exit(1); }

let tasksBaselined = 0;
let tasksSlipped    = 0;

for (let i = 0; i < tasks.length; i++) {
  const task = tasks[i];
  if (!task.start_date && !task.due_date) continue;

  // Pattern: first third of tasks show slip (baselines 5 days earlier than current),
  // remaining two-thirds are on-baseline.
  const slipping = i < Math.ceil(tasks.length / 3);
  const offset = slipping ? -5 : 0;

  const { error } = await db
    .from("tasks")
    .update({
      baseline_start_date: offsetDate(task.start_date, offset),
      baseline_due_date:   offsetDate(task.due_date, offset),
    })
    .eq("id", task.id)
    .eq("workspace_id", W);

  if (error) { console.error(`task ${task.id} update failed:`, error); continue; }
  if (slipping) tasksSlipped++; else tasksBaselined++;
}

console.log(`tasks: ${tasksBaselined} on-baseline, ${tasksSlipped} showing slip (baseline 5d earlier)`);
console.log("✓ Baseline seed complete.");
