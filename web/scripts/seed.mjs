// NoPM — seed a rich, demo-ready workspace. Idempotent: clears prior demo data then inserts.
// Audit rows are append-only (immutability trigger), so we leave history intact and add a few.
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

const ins = async (table, row) => {
  const { data, error } = await db.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
};
const days = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

const ws = (await db.from("workspaces").select("id").eq("slug", "demo").single()).data;
const owner = (await db.from("profiles").select("id").eq("workspace_id", ws.id).limit(1).single()).data.id;
const W = ws.id;
console.log("workspace", W);

// ── clear prior demo data (cascades handle children of projects) ───────────
for (const t of ["deletion_requests", "notifications", "clashes", "resource_members", "projects"]) {
  await db.from(t).delete().eq("workspace_id", W);
}
console.log("cleared");

// ── projects ───────────────────────────────────────────────────────────────
const P = [
  { code: "NBC-CORE", name: "Core Network Consolidation", program: "NBC-H Merger", rag_status: "amber", completion_pct: 62, is_locked: true, lock_reason: "Baseline frozen for steerco" },
  { code: "NBC-BILL", name: "Billing Platform Cutover", program: "NBC-H Merger", rag_status: "red", completion_pct: 38 },
  { code: "NBC-RET", name: "Retail Store Migration", program: "NBC-H Merger", rag_status: "green", completion_pct: 81 },
  { code: "DX-DATA", name: "Customer Data Platform", program: "Digital Transformation", rag_status: "amber", completion_pct: 47 },
  { code: "DX-APP", name: "Super-App Launch", program: "Digital Transformation", rag_status: "green", completion_pct: 73 },
  { code: "DX-SEC", name: "Zero-Trust Security Rollout", program: "Digital Transformation", rag_status: "complete", completion_pct: 100 },
];
const projects = [];
for (const p of P) {
  projects.push(await ins("projects", {
    workspace_id: W, owner_id: owner, currency: "MYR",
    start_date: days(-90), target_date: days(60), ...p,
  }));
}
console.log("projects", projects.length);

// ── milestones + tasks ───────────────────────────────────────────────────
const MS = ["not_started", "on_track", "at_risk", "delayed", "completed"];
const ST = [["Backlog", "backlog"], ["To do", "unstarted"], ["In progress", "started"], ["Done", "completed"]];
const PRI = ["low", "medium", "high", "urgent"];
let taskForDeletion = null;
for (const [pi, proj] of projects.entries()) {
  for (let m = 0; m < 3; m++) {
    const ms = await ins("milestones", {
      workspace_id: W, project_id: proj.id, name: ["Discovery", "Build", "Cutover"][m],
      target_date: days(-30 + m * 30), status: MS[(pi + m) % MS.length],
      completion_pct: [100, 60, 10][m], sort_order: m,
    });
    for (let t = 0; t < 4; t++) {
      const [label, type] = ST[(pi + m + t) % ST.length];
      const task = await ins("tasks", {
        workspace_id: W, project_id: proj.id, milestone_id: ms.id,
        name: `${["Assess", "Design", "Implement", "Verify"][t]} ${["scope", "data", "integration", "rollout"][(pi + t) % 4]}`,
        status: label, status_type: type, priority: PRI[(t + pi) % 4],
        completion_pct: type === "completed" ? 100 : type === "started" ? 45 : 0,
        start_date: days(-20 + t * 5), due_date: days(t * 7), sort_order: t,
      });
      if (pi === 1 && m === 0 && t === 0) taskForDeletion = task;
    }
  }
}
console.log("milestones + tasks done");

// ── risks + issues ──────────────────────────────────────────────────────
const SEV = ["low", "medium", "high", "critical"];
for (const [i, proj] of projects.entries()) {
  await ins("risks", {
    workspace_id: W, project_id: proj.id, owner_id: owner,
    title: ["Vendor SLA slippage", "Data migration integrity", "Resource contention", "Regulatory approval delay", "Legacy API instability", "Change fatigue"][i],
    severity: SEV[i % 4], likelihood: SEV[(i + 1) % 4], category: "Delivery",
    mitigation: "Mitigation owner assigned; weekly review.", status: ["open", "mitigating", "open", "accepted", "mitigating", "closed"][i],
    raised_at: days(-15), due_date: days(20),
  });
  await ins("issues", {
    workspace_id: W, project_id: proj.id, owner_id: owner,
    title: ["UAT defect backlog", "Cutover window conflict", "Test data shortfall", "Integration timeout", "Training gap", "Sign-off pending"][i],
    priority: PRI[i % 4], resolution: i % 2 ? "Workaround in place." : null,
    status: ["open", "in_progress", "open", "resolved", "in_progress", "closed"][i], raised_at: days(-10), due_date: days(10),
  });
}
console.log("risks + issues done");

// ── resources + allocations (one over-allocated) ─────────────────────────
const people = [
  { name: "Aisyah Rahman", role_title: "Programme Lead", cost_rate: 220, capacity_hours_per_week: 40 },
  { name: "Wei Jie Tan", role_title: "Solution Architect", cost_rate: 260, capacity_hours_per_week: 40 },
  { name: "Priya Nair", role_title: "Data Engineer", cost_rate: 180, capacity_hours_per_week: 40 },
  { name: "Daniel Lim", role_title: "QA Lead", cost_rate: 160, capacity_hours_per_week: 40 },
  { name: "Faiz Othman", role_title: "Network Engineer", cost_rate: 190, capacity_hours_per_week: 40 },
];
const members = [];
for (const p of people) members.push(await ins("resource_members", { workspace_id: W, ...p }));
// Wei Jie Tan (index 1) is over-allocated across 3 projects = 140%
const allocPlan = [
  [0, 0, 60], [1, 0, 50], [1, 1, 50], [1, 3, 40], [2, 3, 70], [3, 4, 80], [4, 2, 65],
];
for (const [mi, pi, pct] of allocPlan) {
  await ins("allocations", {
    workspace_id: W, member_id: members[mi].id, project_id: projects[pi].id,
    allocation_pct: pct, window_start: days(-14), window_end: days(28),
  });
}
console.log("resources + allocations done");

// ── clashes (resource over-allocation + a schedule clash) ────────────────
await ins("clashes", {
  workspace_id: W, type: "resource", severity: "high", status: "open",
  title: `Over-allocation: ${members[1].name} (140%)`, resource_member_id: members[1].id,
  window_start: days(-14), window_end: days(28), owner_id: owner,
  resolution: null,
});
await ins("clashes", {
  workspace_id: W, type: "schedule", severity: "medium", status: "investigating",
  title: "Cutover window overlap: Billing vs Retail", project_a_id: projects[1].id, project_b_id: projects[2].id,
  window_start: days(18), window_end: days(25), owner_id: owner,
});
console.log("clashes done");

// ── budgets + expenses + time entries ────────────────────────────────────
const budgets = [[1_200_000, 740_000], [900_000, 610_000], [500_000, 300_000], [800_000, 350_000], [1_500_000, 1_050_000], [400_000, 400_000]];
for (const [i, proj] of projects.entries()) {
  await ins("project_budget", { project_id: proj.id, workspace_id: W, planned_amount: budgets[i][0], committed_amount: budgets[i][1], currency: "MYR" });
  await ins("expenses", { workspace_id: W, project_id: proj.id, description: "Vendor licences", amount: budgets[i][1] * 0.3, category: "Software", incurred_on: days(-20) });
  await ins("time_entries", { workspace_id: W, project_id: proj.id, member_id: members[i % members.length].id, entry_date: days(-5), hours: 120, cost: 120 * people[i % people.length].cost_rate, note: "Sprint effort" });
}
console.log("budgets done");

// ── one pending deletion request (for the approvals queue) ───────────────
if (taskForDeletion) {
  await ins("deletion_requests", {
    workspace_id: W, target_type: "task", target_id: taskForDeletion.id, reason: "Superseded by revised cutover plan",
    status: "pending", requested_by_type: "token", requested_by_id: owner, requested_by_label: "maker (agent)",
    before: taskForDeletion,
  });
}

// ── a few audit rows for a lively Trust Center ───────────────────────────
const auditRows = [
  { action: "project.create", target_type: "project", target_id: projects[0].id },
  { action: "project.lock", target_type: "project", target_id: projects[0].id },
  { action: "task.update", target_type: "task", target_id: taskForDeletion?.id },
  { action: "risk.create", target_type: "risk", target_id: null },
  { action: "task.delete_requested", target_type: "task", target_id: taskForDeletion?.id },
];
for (const a of auditRows) {
  await db.from("audit_log").insert({ workspace_id: W, actor_type: "user", actor_id: owner, actor_label: "Chu Ling", ...a });
}

console.log("\n✓ Seed complete — demo workspace is rich and ready.");
