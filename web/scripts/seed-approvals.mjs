// Seed one pending deletion request for the 'demo' workspace approvals queue.
// Modeled on seed-change-control.mjs's four-eyes profile resolution: a
// non-admin member raises the request so the logged-in admin can approve it
// live (maker-checker: requester and approver must differ, or the atomic
// commit RPC raises SELF_APPROVAL — see supabase/migrations/
// 20260608000006_governance.sql's maker_checker_different CHECK and
// 20260608000020_atomic_deletion_commit.sql).
//
// This MUST run after seed-members.mjs — that script is what creates the
// non-admin profiles (Priya Nair / manager, Daniel Okoro / member). Running
// this before seed-members.mjs (or standalone against a workspace with only
// the admin profile) will throw rather than silently reproduce the
// self-approval bug it exists to fix.
//
// Idempotent: clears prior deletion_requests for the workspace, then inserts.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(here, "..", ".env.local"), "utf8")
    .split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const W = (await db.from("workspaces").select("id").eq("slug", "demo").single()).data.id;
console.log("workspace:", W);

// Resolve the requester (four-eyes: whoever approves live in the demo must
// NOT be the same id as requested_by_id). The approver can be EITHER the
// admin login or the one-click demo account (DEMO_EMAIL, promoted to
// manager by seed-members.mjs) — so the requester must be a named seeded
// member who is neither an admin nor the demo login itself. A loose
// "first non-admin" lookup here could pick the demo account by row order,
// which would resurrect the SELF_APPROVAL 403 for one-click visitors.
const profiles = (
  await db.from("profiles").select("id, display_name, role, email").eq("workspace_id", W).limit(10)
).data ?? [];
const demoEmail = env.DEMO_EMAIL ?? "";
const requester =
  profiles.find((p) => p.email === "priya.nair@stillnotbald.com") ??
  profiles.find((p) => p.role !== "admin" && p.role !== "viewer" && p.email !== demoEmail);
if (!requester) {
  throw new Error("No eligible requester profile (non-admin, non-viewer, not the demo login) — run seed-members.mjs first");
}

// Pick the same real seeded task seed.mjs used to reserve for deletion:
// project FIN-MIG (P[1] in seed.mjs) → milestone "Discovery" (blueprint[0])
// → first task template (sort_order 0, "Run stakeholder discovery workshops").
const project = (
  await db.from("projects").select("id, name").eq("workspace_id", W).eq("code", "FIN-MIG").single()
).data;
if (!project) throw new Error("FIN-MIG project not found (run seed.mjs first)");

const milestone = (
  await db.from("milestones").select("id, name").eq("workspace_id", W).eq("project_id", project.id).eq("name", "Discovery").single()
).data;
if (!milestone) throw new Error("Discovery milestone not found under FIN-MIG (run seed.mjs first)");

const taskForDeletion = (
  await db.from("tasks").select("*").eq("workspace_id", W).eq("milestone_id", milestone.id).eq("sort_order", 0).single()
).data;
if (!taskForDeletion) throw new Error("Task with sort_order 0 not found under FIN-MIG/Discovery (run seed.mjs first)");

// ── clear prior demo deletion requests, then insert the fresh pending one ──
await db.from("deletion_requests").delete().eq("workspace_id", W);
console.log("cleared");

const { error } = await db.from("deletion_requests").insert({
  workspace_id: W,
  target_type: "task",
  target_id: taskForDeletion.id,
  reason: "Superseded by revised cutover plan",
  status: "pending",
  requested_by_type: "token",
  requested_by_id: requester.id,
  requested_by_label: "maker (agent)",
  before: taskForDeletion,
});
if (error) throw new Error(`deletion_requests: ${error.message}`);

console.log(`deletion_requests: 1 pending — task "${taskForDeletion.name}" (${project.name}), requested by ${requester.display_name} (${requester.role})`);
console.log("✓ Approvals seed complete.");
