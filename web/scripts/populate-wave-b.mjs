// One-off: populate demo data for Wave B features (task dependencies, checklists,
// clash enrichment) so they're visible. Idempotent for deps (clears first). Data only.
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { loadEnv, requireEnv } from "./lib/env.mjs";

const env = requireEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], loadEnv());
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const W = (await db.from("workspaces").select("id").eq("slug", "demo").single()).data.id;

// 1. FS dependency chains within each milestone (first 3 projects) → Gantt arrows + critical path
const projects = (await db.from("projects").select("id,code").order("created_at")).data ?? [];
await db.from("task_dependencies").delete().eq("workspace_id", W);
let depCount = 0;
for (const p of projects.slice(0, 3)) {
  const ms = (await db.from("milestones").select("id").eq("project_id", p.id).order("sort_order")).data ?? [];
  for (const m of ms) {
    const tasks = (await db.from("tasks").select("id").eq("milestone_id", m.id).order("sort_order")).data ?? [];
    for (let i = 1; i < tasks.length; i++) {
      const { error } = await db.from("task_dependencies").insert({
        workspace_id: W, predecessor_id: tasks[i - 1].id, successor_id: tasks[i].id, type: "FS", lag_days: 0,
      });
      if (!error) depCount++;
    }
  }
}
console.log("task dependencies:", depCount);

// 2. checklists on a sample of tasks
const item = (text, done) => ({ id: randomUUID(), text, done });
const someTasks = (await db.from("tasks").select("id,name").order("created_at").limit(8)).data ?? [];
for (const t of someTasks) {
  await db.from("tasks").update({
    checklist: [
      item("Acceptance criteria agreed with owner", true),
      item("Build complete", t.name.length % 2 === 0),
      item("Peer review / QA", false),
      item("Documentation updated", false),
    ],
  }).eq("id", t.id);
}
console.log("checklists:", someTasks.length);

// 3. enrich clashes
const clashes = (await db.from("clashes").select("id,title,type").eq("workspace_id", W)).data ?? [];
for (const c of clashes) {
  await db.from("clashes").update({
    description: `Detected contention on "${c.title}": two workstreams compete for the same constrained window, putting delivery dates on both at risk if unresolved.`,
    recommended_action: c.type === "resource"
      ? "Re-level the allocation or widen the capacity window; escalate to the resource owner for a priority call."
      : "Sequence the dependent work and add schedule buffer; confirm the new order with both project leads.",
    over_allocation_pct: c.type === "resource" ? 140 : null,
  }).eq("id", c.id);
}
console.log("clashes enriched:", clashes.length);

// 4. demo notifications for the workspace owner (so the bell + My Work show data)
const owner = (await db.from("profiles").select("id").eq("workspace_id", W).limit(1).single()).data.id;
await db.from("notifications").delete().eq("workspace_id", W);
const notifs = [
  { type: "approval.requested", title: "Approval needed: delete task", body: "A task deletion is awaiting a second reviewer (four-eyes).", payload: { href: "/approvals" } },
  { type: "risk.escalated", title: "High risk logged", body: "Integrator SLA slippage flagged High on S/4HANA Core Rollout — EMEA.", payload: { href: "/risks" } },
  { type: "clash.detected", title: "Resource over-allocation", body: "Marcus Bauer is allocated ~140% — a resource clash was auto-detected.", payload: { href: "/clashes" } },
];
for (const n of notifs) {
  await db.from("notifications").insert({ workspace_id: W, recipient_id: owner, ...n });
}
console.log("notifications:", notifs.length);

console.log("✓ Wave B demo data populated.");
