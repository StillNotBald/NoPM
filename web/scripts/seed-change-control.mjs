// Seed change requests and decision log for the 'demo' workspace.
// Idempotent: clears prior change_requests + decisions for the workspace, then inserts.
import { createClient } from "@supabase/supabase-js";
import { loadEnv, requireEnv } from "./lib/env.mjs";

const env = requireEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], loadEnv());

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const W = (await db.from("workspaces").select("id").eq("slug", "demo").single()).data.id;
console.log("workspace:", W);

// Resolve two distinct profiles so we can satisfy the four-eyes CHECK
// (decided_by must differ from requested_by for approved/rejected rows).
const profiles = (
  await db.from("profiles").select("id, display_name, role").eq("workspace_id", W).limit(5)
).data ?? [];

if (profiles.length < 2) {
  throw new Error("Need at least 2 profiles in the demo workspace for four-eyes seed data (run seed-members.mjs first)");
}

// The admin is the deciding authority; a non-admin member raises the requests.
// Pending CRs are therefore raised by the member, so the logged-in admin can
// approve/reject them live (four-eyes: decider must differ from requester).
const admin = profiles.find((p) => p.role === "admin") ?? profiles[0];
const member = profiles.find((p) => p.role !== "admin") ?? profiles[1];
const requester = member;
const approver = admin;

// Resolve a couple of projects for project-scoped rows.
const projects = (
  await db.from("projects").select("id, code").eq("workspace_id", W).order("created_at").limit(3)
).data ?? [];

const p1 = projects[0]?.id ?? null;
const p2 = projects[1]?.id ?? null;
const p3 = projects[2]?.id ?? null;

// ── clear prior demo change-control data ─────────────────────────────────
await db.from("change_requests").delete().eq("workspace_id", W);
await db.from("decisions").delete().eq("workspace_id", W);
console.log("cleared");

// ── change_requests (CR-001 … CR-008) ────────────────────────────────────
const now = new Date().toISOString();
const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };

const crRows = [
  {
    workspace_id: W,
    project_id: p1,
    reference_id: "CR-001",
    title: "Extend ERP go-live by 4 weeks to accommodate SI delivery slippage",
    description:
      "The systems-integrator has flagged a 4-week delivery delay on the FICO integration module. Extending the go-live date preserves data-reconciliation quality and avoids a forced partial cutover.",
    category: "schedule",
    priority: "high",
    status: "approved",
    impact_summary: "Go-live moves from 2026-07-14 to 2026-08-11; no budget breach.",
    impact_schedule_days: 28,
    impact_cost: 0,
    requested_by: requester.id,
    requested_by_label: requester.display_name ?? "PM",
    decided_by: approver.id,
    decided_by_label: approver.display_name ?? "Sponsor",
    decision_rationale:
      "Sponsor agrees: a forced partial cutover would be higher risk than a 4-week extension. Programme board notified.",
    raised_at: daysAgo(14),
    decided_at: daysAgo(7),
    target_date: daysFromNow(60),
  },
  {
    workspace_id: W,
    project_id: p1,
    reference_id: "CR-002",
    title: "Add APAC HR module to ERP scope (previously deferred)",
    description:
      "Stakeholder escalation from APAC COO to include the HR payroll module in the current ERP wave rather than pushing to wave 2. Requires 8 additional sprint weeks and $340K contractor cost.",
    category: "scope",
    priority: "critical",
    status: "under_review",
    impact_summary: "+8 sprint weeks, +$340K contractor cost.",
    impact_schedule_days: 56,
    impact_cost: 340000,
    requested_by: requester.id,
    requested_by_label: requester.display_name ?? "PM",
    decided_by: null,
    decided_by_label: null,
    decision_rationale: null,
    raised_at: daysAgo(5),
    decided_at: null,
    target_date: daysFromNow(14),
  },
  {
    workspace_id: W,
    project_id: p2,
    reference_id: "CR-003",
    title: "Replace GL conversion engine with vendor-supplied reconciliation tool",
    description:
      "Current bespoke GL conversion engine has unacceptable defect rates. Vendor proposes a proven reconciliation accelerator at $85K licence. Reduces QA sprint count from 6 to 2.",
    category: "scope",
    priority: "high",
    status: "under_review",
    impact_summary: "+$85K licence, -4 QA sprints (net schedule improvement).",
    impact_schedule_days: -14,
    impact_cost: 85000,
    requested_by: requester.id,
    requested_by_label: requester.display_name ?? "PM",
    decided_by: null,
    decided_by_label: null,
    decision_rationale: null,
    raised_at: daysAgo(3),
    decided_at: null,
    target_date: daysFromNow(7),
  },
  {
    workspace_id: W,
    project_id: p2,
    reference_id: "CR-004",
    title: "Defer historical statutory-archive migration to a separate phase",
    description:
      "Archive migration is consuming 18% of the data-engineering capacity needed for live GL conversion. Deferral to a follow-on phase removes the bottleneck without scope risk to the core deliverable.",
    category: "scope",
    priority: "medium",
    status: "approved",
    impact_summary: "Removes archive stream from critical path; -3 weeks to conversion milestone.",
    impact_schedule_days: -21,
    impact_cost: 0,
    requested_by: requester.id,
    requested_by_label: requester.display_name ?? "PM",
    decided_by: approver.id,
    decided_by_label: approver.display_name ?? "Sponsor",
    decision_rationale:
      "Accepted. Archive can follow in a standalone data phase post-ERP go-live. Owner to document exclusion in scope statement.",
    raised_at: daysAgo(20),
    decided_at: daysAgo(12),
    target_date: null,
  },
  {
    workspace_id: W,
    project_id: p3,
    reference_id: "CR-005",
    title: "Increase cloud landing-zone egress budget by $60K for final migration wave",
    description:
      "Wave 4 workloads (analytics and batch jobs) have higher egress volumes than estimated. Additional $60K covers migration-phase data transfer without exceeding the DR budget.",
    category: "cost",
    priority: "medium",
    status: "approved",
    impact_summary: "+$60K one-off cloud egress cost during migration window.",
    impact_schedule_days: 0,
    impact_cost: 60000,
    requested_by: requester.id,
    requested_by_label: requester.display_name ?? "PM",
    decided_by: approver.id,
    decided_by_label: approver.display_name ?? "Sponsor",
    decision_rationale:
      "Within contingency reserve. Approved. Finance to tag against cloud programme budget line.",
    raised_at: daysAgo(10),
    decided_at: daysAgo(6),
    target_date: null,
  },
  {
    workspace_id: W,
    project_id: p3,
    reference_id: "CR-006",
    title: "Renegotiate datacenter exit date from 2026-09-30 to 2026-12-15",
    description:
      "Final-wave network re-home is blocked on ERP-EMEA shared-connectivity sign-off. Extending the datacenter contract by one quarter avoids a forced cutover under dependency risk.",
    category: "schedule",
    priority: "high",
    status: "under_review",
    impact_summary: "+77 days datacenter cost (~$110K); removes risk of forced cutover.",
    impact_schedule_days: 77,
    impact_cost: 110000,
    requested_by: requester.id,
    requested_by_label: requester.display_name ?? "PM",
    decided_by: null,
    decided_by_label: null,
    decision_rationale: null,
    raised_at: daysAgo(2),
    decided_at: null,
    target_date: daysFromNow(5),
  },
  {
    workspace_id: W,
    project_id: p1,
    reference_id: "CR-007",
    title: "Reject request to include tax-engine customisation in ERP wave 1",
    description:
      "Finance requested a full tax-engine customisation layer as in-scope. Programme governance rejected this as a wave-2 candidate to protect the wave-1 go-live schedule.",
    category: "scope",
    priority: "low",
    status: "rejected",
    impact_summary: "No impact on wave 1; deferred to wave 2 scope backlog.",
    impact_schedule_days: 0,
    impact_cost: 0,
    requested_by: requester.id,
    requested_by_label: requester.display_name ?? "PM",
    decided_by: approver.id,
    decided_by_label: approver.display_name ?? "Sponsor",
    decision_rationale:
      "Out of scope for this wave. Tax customisation will be evaluated as a wave-2 item post go-live.",
    raised_at: daysAgo(30),
    decided_at: daysAgo(25),
    target_date: null,
  },
  {
    workspace_id: W,
    project_id: null,
    reference_id: "CR-008",
    title: "Programme-level: introduce unified change-control tooling for all workstreams",
    description:
      "PMO proposes adopting NoPM change-control register as the single source of truth across all programmes. Replaces ad-hoc email/spreadsheet tracking.",
    category: "quality",
    priority: "medium",
    status: "raised",
    impact_summary: "Minimal cost; improves governance traceability across all workstreams.",
    impact_schedule_days: 0,
    impact_cost: 0,
    requested_by: requester.id,
    requested_by_label: requester.display_name ?? "PM",
    decided_by: null,
    decided_by_label: null,
    decision_rationale: null,
    raised_at: now,
    decided_at: null,
    target_date: daysFromNow(21),
  },
];

// R-83: every row is raised/decided by a real profile (a "user" actor) —
// backfill the actor-typed pair alongside the legacy profile-id columns so
// this seed matches what the API writes from 0043 on.
// 0045 (principal-aware four-eyes): the HUMAN on each side is recorded too.
// For a "user" actor the principal is simply the profile id; the CHECK
// cr_principal_distinct requires decider <> requester.
for (const cr of crRows) {
  cr.requested_by_type = "user";
  cr.requested_by_id = cr.requested_by;
  cr.requested_principal_id = cr.requested_by;
  cr.decided_by_type = cr.decided_by ? "user" : null;
  cr.decided_by_id = cr.decided_by;
  cr.decided_principal_id = cr.decided_by;
}

for (const cr of crRows) {
  const { error } = await db.from("change_requests").insert(cr);
  if (error) throw new Error(`change_requests: ${error.message}`);
}
console.log("change_requests:", crRows.length);

// ── decisions (DEC-001 … DEC-006) ─────────────────────────────────────────

// Insert DEC-001 first so DEC-006 can reference it as superseded.
const decBase = {
  workspace_id: W,
  decided_by: approver.id,
  decided_by_label: approver.display_name ?? "Sponsor",
  decided_at: daysAgo(30),
};

const { data: dec1, error: dec1Err } = await db
  .from("decisions")
  .insert({
    ...decBase,
    project_id: p1,
    reference_id: "DEC-001",
    title: "Adopt phased ERP go-live (finance first, logistics wave 2)",
    context:
      "Initial programme plan proposed a big-bang go-live across finance and logistics simultaneously. Risk modelling showed combined cutover risk was unacceptable given SI delivery confidence.",
    options:
      "Option A: Big-bang go-live (all modules at once). Option B: Phased — finance first, logistics in wave 2. Option C: Defer to next fiscal year.",
    decision: "Option B — phased go-live, finance first.",
    rationale:
      "Reduces cutover blast radius; finance module is higher-certainty; logistics can follow within the fiscal year. Accepted by programme board 2026-05-10.",
    status: "accepted",
    decided_at: daysAgo(30),
    supersedes: null,
  })
  .select()
  .single();
if (dec1Err) throw new Error(`DEC-001: ${dec1Err.message}`);

const decRows = [
  {
    ...decBase,
    project_id: p2,
    reference_id: "DEC-002",
    title: "Use vendor reconciliation accelerator for GL conversion",
    context:
      "Bespoke GL conversion engine had 4.7% defect rate in dress rehearsal. Fiscal-year close window is fixed; no time for a full re-build.",
    options:
      "Option A: Re-build bespoke engine (6 sprint weeks). Option B: Procure vendor reconciliation accelerator ($85K, 2-week integration). Option C: Manual reconciliation (operationally unacceptable).",
    decision: "Option B — vendor reconciliation accelerator.",
    rationale:
      "Cost of a failed close window exceeds $85K by an order of magnitude. Vendor tool has proven track record on similar ERP migrations.",
    status: "accepted",
    decided_at: daysAgo(3),
    supersedes: null,
  },
  {
    ...decBase,
    project_id: p3,
    reference_id: "DEC-003",
    title: "Wave-based migration order: non-production first, then production workloads",
    context:
      "Cloud migration could proceed in any order. Non-prod-first reduces risk and allows the ops team to build landing-zone confidence before touching production.",
    options:
      "Option A: Migrate production and non-production concurrently. Option B: Non-prod first, production follows. Option C: Production-only (abandon non-prod environment consolidation).",
    decision: "Option B — non-production environments migrate first in wave 1-2; production in wave 3-4.",
    rationale:
      "Operational risk is substantially lower; team gains runbook confidence before production workloads are at risk.",
    status: "accepted",
    decided_at: daysAgo(60),
    supersedes: null,
  },
  {
    workspace_id: W,
    project_id: null,
    reference_id: "DEC-004",
    title: "NoPM as programme-level RAID and change register — proposed (under review)",
    context:
      "PMO evaluated several tools for programme-level risk, decision, and change tracking. NoPM emerged as the preferred platform for its API-first governance model.",
    options:
      "Option A: Extend existing spreadsheet tracking. Option B: Enterprise PPM tool (Planview, $120K/yr). Option C: NoPM as programme register (governance-native, lower cost).",
    decision: null,
    rationale: null,
    status: "proposed",
    decided_by: null,
    decided_by_label: null,
    decided_at: null,
    supersedes: null,
  },
  {
    ...decBase,
    project_id: p2,
    reference_id: "DEC-005",
    title: "(Superseded) Pursue parallel-ledger strategy for GL migration",
    context:
      "Original approach was to run the legacy and new GL in parallel for 3 months post-cutover to allow reconciliation.",
    options: "Option A: Full parallel-ledger (3 months). Option B: Single cutover with snapshot reconciliation.",
    decision: "Option A — parallel-ledger strategy.",
    rationale:
      "Initial decision based on available QA capacity. Superseded when vendor reconciliation accelerator was adopted (DEC-002), making parallel ledger unnecessary.",
    status: "superseded",
    decided_at: daysAgo(45),
    supersedes: null,
  },
  {
    ...decBase,
    project_id: p1,
    reference_id: "DEC-006",
    title: "Revise ERP phasing: include order-to-cash in finance wave (supersedes DEC-001)",
    context:
      "Post DEC-001, stakeholder review identified that separating order-to-cash from finance creates reconciliation gaps. Order-to-cash must be in the same wave.",
    options:
      "Option A: Keep DEC-001 (OTC in wave 2). Option B: Add OTC to wave 1 alongside finance (revised scope, +3 weeks).",
    decision: "Option B — include order-to-cash in finance wave.",
    rationale:
      "Reconciliation integrity requires OTC and finance to go live together. Programme board accepted revised timeline 2026-06-01.",
    status: "accepted",
    decided_at: daysAgo(7),
    supersedes: dec1.id,
  },
];

for (const dec of decRows) {
  const { error } = await db.from("decisions").insert(dec);
  if (error) throw new Error(`decisions: ${error.message}`);
}
console.log("decisions:", decRows.length + 1); // +1 for DEC-001

console.log("Change control seed complete.");
