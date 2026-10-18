// Unify identity: link login profiles to resource_members (profile_id), then
// assign open tasks to resource_members (so assignment ↔ capacity ↔ cost are one
// person), and give each login member a starter allocation so utilization shows.
// Idempotent-ish. Run AFTER migration 0019 + seed-members.mjs.
import { createClient } from "@supabase/supabase-js";
import { loadEnv, requireEnv } from "./lib/env.mjs";

const env = requireEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], loadEnv());
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const W = (await db.from("workspaces").select("id").eq("slug", "demo").single()).data.id;
const profiles = (await db.from("profiles").select("id, display_name, email, role").eq("workspace_id", W)).data ?? [];
let members = (await db.from("resource_members").select("id, name, profile_id").eq("workspace_id", W)).data ?? [];

// 1) Link each login profile to a resource_member (by first name) or create one.
for (const p of profiles) {
  const first = (p.display_name || "").split(/\s+/)[0].toLowerCase();
  const match = members.find((m) => !m.profile_id && m.name.toLowerCase().startsWith(first));
  if (match) {
    await db.from("resource_members")
      .update({ profile_id: p.id, name: p.display_name, email: p.email })
      .eq("id", match.id);
    match.profile_id = p.id;
  } else {
    const role_title = p.role === "admin" ? "Programme Director" : p.role === "manager" ? "Delivery Lead" : "Project Manager";
    const cost_rate = p.role === "admin" ? 140 : p.role === "manager" ? 110 : 85;
    const ins = await db.from("resource_members").insert({
      workspace_id: W, name: p.display_name, email: p.email, role_title,
      cost_rate, capacity_hours_per_week: 40, profile_id: p.id,
    }).select("id, name, profile_id").single();
    if (ins.data) members.push(ins.data);
  }
}
members = (await db.from("resource_members").select("id, name, profile_id").eq("workspace_id", W)).data ?? [];
const adminProfile = profiles.find((p) => p.role === "admin");
const adminMember = members.find((m) => m.profile_id === adminProfile?.id);
console.log("members linked to logins:", members.filter((m) => m.profile_id).map((m) => m.name).join(", "));

// 2) Assign open tasks to resource_members (assignee_id -> resource_members now).
//    Weight the demo admin's member to ~25% so their My Tasks is rich.
const others = members.filter((m) => m.id !== adminMember?.id);
const openTasks = (await db.from("tasks").select("id").eq("workspace_id", W)
  .not("status_type", "in", '("completed","canceled")').order("created_at")).data ?? [];
let oi = 0, assigned = 0;
for (let i = 0; i < openTasks.length; i++) {
  if (i % 6 === 5) continue; // ~1/6 unassigned
  let memberId;
  if (adminMember && i % 4 === 0) memberId = adminMember.id;
  else { memberId = others[oi % others.length].id; oi++; }
  const { error } = await db.from("tasks").update({ assignee_id: memberId }).eq("id", openTasks[i].id);
  if (!error) assigned++;
}
console.log("tasks assigned to members:", assigned, "of", openTasks.length);

// 3) Give each login member a starter allocation so the Resources utilization
//    view shows them (skip if they already have one).
const projects = (await db.from("projects").select("id").eq("workspace_id", W).order("created_at")).data ?? [];
for (const [idx, m] of members.filter((x) => x.profile_id).entries()) {
  const has = (await db.from("allocations").select("id", { count: "exact", head: true })
    .eq("workspace_id", W).eq("member_id", m.id)).count;
  if (!has && projects[idx % projects.length]) {
    await db.from("allocations").insert({
      workspace_id: W, member_id: m.id, project_id: projects[idx % projects.length].id, allocation_pct: 50,
    });
  }
}
console.log("✓ identity unified: profiles ↔ resource_members ↔ task assignment ↔ allocations.");
