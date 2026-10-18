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
//
// PROJECT-DELETION FOUR-EYES (devops-wave1b, U1): scopes project:delete:request
// / project:delete:approve now exist in the registry (web/src/lib/auth/
// scopes.ts) and the atomic commit RPC (nopm_commit_project_deletion,
// migration 20260814000032) is landed — but this script deliberately does
// NOT yet seed a pending target_type='project' row here, for two reasons:
//   1. There is no PAT-scope granting in THIS script to extend — the
//      maker/checker api_tokens fixtures live in scripts/bootstrap.mjs.
//      (The wildcard hazard this note used to describe — "project:*" also
//      granting project:delete:approve — is closed twice over: bootstrap now
//      lists explicit project scopes, and since 2026-10-16 hasScope() never
//      lets a wildcard grant an approve/decide scope at all.)
//   2. The approve/reject routes (web/src/app/api/deletion-requests/[id]/
//      {approve,reject}/route.ts) are still hardcoded to
//      nopm_commit_task_deletion + require task:delete:approve only — they
//      do not yet dispatch on target_type. Seeding a clickable pending
//      target_type='project' row before that dispatch wiring lands would be
//      approvable through the STALE route: it would mark the request
//      committed and write an audit row mislabeled 'task.delete' for
//      target_type='project', without actually deleting the project. Add
//      the project-fixture insert here (mirroring the task one below) only
//      once that route dispatch is wired to call nopm_commit_project_deletion
//      + require project:delete:approve.
import { createClient } from "@supabase/supabase-js";
import { loadEnv, requireEnv } from "./lib/env.mjs";

const env = requireEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], loadEnv());
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
  // 0045 (principal-aware four-eyes): four-eyes compares the HUMAN behind the
  // requester, not the actor id — whoever approves (the admin login, the
  // one-click demo manager, or the seeded "checker (agent)" token, which the
  // bootstrap script gives a DIFFERENT owner than the maker token) must be a
  // different person from this requester.
  requested_principal_id: requester.id,
  before: taskForDeletion,
});
if (error) throw new Error(`deletion_requests: ${error.message}`);

console.log(`deletion_requests: 1 pending — task "${taskForDeletion.name}" (${project.name}), requested by ${requester.display_name} (${requester.role})`);
console.log("✓ Approvals seed complete.");
