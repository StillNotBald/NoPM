// NoPM — seed a rich, demo-ready workspace. Idempotent: clears prior demo data then inserts.
// Audit rows are append-only (immutability trigger), so we leave history intact and add a few.
// Enriched (0008 content_enrichment): project charters, PMBOK risk-register fields,
// RAID-parity issues, 5-8 tasks/milestone, baseline pairs, EVM-ready budgets.
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

// ── projects (with PMBOK charter block + baseline pair + phase) ─────────────
const P = [
  {
    code: "NBC-CORE", name: "Core Network Consolidation", program: "NBC-H Merger",
    rag_status: "amber", completion_pct: 62, is_locked: true, lock_reason: "Baseline frozen for steerco",
    phase: "execution",
    business_case: "The NBC-H merger duplicated two national core networks at a combined run-rate of RM 18M/yr. Consolidating onto a single converged core removes the duplicate OPEX, frees three data-centre halls for divestment, and is the dependency gate for every downstream Digital Transformation programme.",
    objective: "Migrate all subscriber traffic onto the unified core, decommission the legacy NBC ring, and achieve a single network-operations pane of glass — with zero unplanned customer outage during cutover.",
    scope_summary: "In scope: transport convergence, IP/MPLS re-homing, NOC tooling unification, and legacy decommission. Out of scope: radio access refresh (separate programme) and retail POS (NBC-RET).",
    sponsor: "Datuk Lim Cheng Wei (Group CTO)",
    project_manager: "Aisyah Rahman",
    health_commentary: "Amber: vendor integration gates are slipping and float is being consumed, but no scope or budget breach yet. Holding amber pending the SLA escalation outcome.",
  },
  {
    code: "NBC-BILL", name: "Billing Platform Cutover", program: "NBC-H Merger",
    rag_status: "red", completion_pct: 38,
    phase: "execution",
    business_case: "Two billing stacks cannot co-exist past the regulatory merger deadline; running both risks double-billing customers and a MCMC compliance finding. A single billing platform is mandatory for the merged licence and unlocks RM 6M/yr in licence and support savings.",
    objective: "Cut all 4.2M subscriber accounts over to the unified billing platform within one regulated billing cycle, with reconciled balances and no revenue leakage.",
    scope_summary: "In scope: account migration, rating/charging re-platform, dunning, and finance GL re-integration. Out of scope: CRM front-end (DX-APP) and historical statement archival.",
    sponsor: "Sarah Goh (Group CFO)",
    project_manager: "Aisyah Rahman",
    health_commentary: "Red: reconciliation defects in the rating engine are blocking the cutover dress-rehearsal, and the regulated billing-cycle window is fixed. Recovery plan tabled at steerco; needs an extra QA squad.",
  },
  {
    code: "NBC-RET", name: "Retail Store Migration", program: "NBC-H Merger",
    rag_status: "green", completion_pct: 81,
    phase: "execution",
    business_case: "320 combined retail outlets run two incompatible POS and inventory systems. Unifying onto one retail stack standardises the customer experience, enables group-wide promotions, and reduces in-store support cost.",
    objective: "Migrate all 320 stores to the unified POS/inventory platform in waves, with under 30 minutes of till downtime per store and full stock reconciliation.",
    scope_summary: "In scope: POS rollout, inventory cut, staff enablement, and store-network re-homing. Out of scope: e-commerce and warehouse WMS.",
    sponsor: "Tan Boon Huat (Retail MD)",
    project_manager: "Aisyah Rahman",
    health_commentary: "Green: wave 1-3 stores live and stable, ahead of the enablement curve. Watching only the final-wave network re-home, which depends on NBC-CORE.",
  },
  {
    code: "DX-DATA", name: "Customer Data Platform", program: "Digital Transformation",
    rag_status: "amber", completion_pct: 47,
    phase: "execution",
    business_case: "Customer data is fragmented across 11 source systems, blocking any single-customer-view, personalisation, or churn modelling. A unified CDP is the foundational data asset for the entire Digital Transformation programme and the precondition for the Super-App.",
    objective: "Stand up a governed customer data platform with a resolved single-customer-view across all source systems, exposed via a consent-aware API.",
    scope_summary: "In scope: ingestion, identity resolution, consent management, and the CDP serving API. Out of scope: ML model training and marketing-automation tooling.",
    sponsor: "Datuk Lim Cheng Wei (Group CTO)",
    project_manager: "Aisyah Rahman",
    health_commentary: "Amber: identity-resolution match rates are below target on legacy records and the data-engineering lead is over-allocated across three programmes. Resourcing flagged as a clash.",
  },
  {
    code: "DX-APP", name: "Super-App Launch", program: "Digital Transformation",
    rag_status: "green", completion_pct: 73,
    phase: "execution",
    business_case: "Customers interact through five disconnected apps with low engagement. A single super-app consolidating telco, retail, and payments raises monthly active usage, opens a cross-sell channel, and is the flagship customer-facing proof of the transformation.",
    objective: "Launch a unified super-app (telco self-care + retail + wallet) to general availability, hitting the agreed activation and crash-free-session targets.",
    scope_summary: "In scope: app shell, self-care, retail catalogue, wallet onboarding, and the CDP-backed personalisation surface. Out of scope: third-party mini-programs (phase 2).",
    sponsor: "Sarah Goh (Group CFO)",
    project_manager: "Aisyah Rahman",
    health_commentary: "Green: beta cohort metrics are above target and the store-submission track is on schedule. Dependency on DX-DATA personalisation is the only watch item.",
  },
  {
    code: "DX-SEC", name: "Zero-Trust Security Rollout", program: "Digital Transformation",
    rag_status: "complete", completion_pct: 100,
    phase: "closing",
    business_case: "The merged estate inherited flat-network trust and inconsistent identity controls — an audit and breach exposure. A zero-trust architecture (identity-aware access, micro-segmentation, continuous verification) was mandated by the board risk committee.",
    objective: "Roll out zero-trust access and micro-segmentation across all corporate and production estates, retire legacy VPN trust, and pass the independent control assessment.",
    scope_summary: "In scope: IAM uplift, device posture, network micro-segmentation, and VPN decommission. Out of scope: customer-facing fraud controls.",
    sponsor: "Datuk Lim Cheng Wei (Group CTO)",
    project_manager: "Aisyah Rahman",
    health_commentary: "Complete: independent control assessment passed with no major findings; legacy VPN trust retired. Programme in closeout / benefits-tracking.",
  },
];
const projects = [];
for (const p of P) {
  projects.push(await ins("projects", {
    workspace_id: W, owner_id: owner, currency: "MYR",
    start_date: days(-90), target_date: days(60),
    baseline_start_date: days(-90), baseline_target_date: days(45), // baseline finish earlier than current target → visible schedule slip
    ...p,
  }));
}
console.log("projects", projects.length);

// ── milestones + tasks (5-8 tasks each, real descriptions + agile metadata) ──
const MS = ["not_started", "on_track", "at_risk", "delayed", "completed"];
const ST = [["Backlog", "backlog"], ["To do", "unstarted"], ["In progress", "started"], ["Done", "completed"]];
const PRI = ["low", "medium", "high", "urgent"];

const MILESTONE_BLUEPRINT = [
  {
    name: "Discovery", completion_pct: 100, status: "completed",
    description: "Establish the as-is baseline, confirm scope boundaries with the sponsor, and produce the signed-off discovery pack that gates funding release for the build phase.",
    deliverable: "Approved discovery pack: current-state assessment, scope statement, high-level solution architecture, and the funding business case.",
  },
  {
    name: "Build", completion_pct: 60, status: "on_track",
    description: "Construct and integration-test the target solution against the discovery design, iterating in fortnightly increments with the steering committee reviewing each demo.",
    deliverable: "Integration-tested release candidate deployed to the staging environment with all P0 acceptance criteria met.",
  },
  {
    name: "Cutover", completion_pct: 10, status: "at_risk",
    description: "Execute the production cutover via the rehearsed runbook, run the hypercare window, then formally hand over to operations and close the workstream.",
    deliverable: "Production cutover complete, hypercare exited, operational runbook and support model handed to BAU.",
  },
];

// 5-8 task templates per milestone, with acceptance criteria / estimates / labels.
const TASK_TEMPLATES = {
  Discovery: [
    { name: "Run stakeholder discovery workshops", ac: "All eight workstream leads interviewed; RAID items logged; workshop notes signed off by each lead.", est: 24, sp: 5, labels: ["discovery", "stakeholder"] },
    { name: "Document current-state architecture", ac: "As-is diagram covers every in-scope system and integration; reviewed by the solution architect.", est: 32, sp: 8, labels: ["architecture", "documentation"] },
    { name: "Define scope statement & boundaries", ac: "In/out-of-scope list approved by sponsor; no open boundary questions remain.", est: 16, sp: 3, labels: ["scope"] },
    { name: "Assess data quality of source systems", ac: "Profiling report delivered with defect rates per source; remediation backlog raised.", est: 28, sp: 5, labels: ["data", "quality"] },
    { name: "Draft high-level solution design", ac: "Target-state design covers all capabilities; key decisions captured as ADRs.", est: 36, sp: 8, labels: ["architecture", "design"] },
    { name: "Build funding business case", ac: "Cost-benefit model peer-reviewed by finance; NPV and payback agreed.", est: 20, sp: 5, labels: ["finance"] },
    { name: "Discovery gate sign-off", ac: "Discovery pack approved at the gate review; minutes recorded; build funding released.", est: 8, sp: 2, labels: ["governance", "gate"] },
  ],
  Build: [
    { name: "Stand up environments (dev/test/stage)", ac: "All three environments provisioned, access-controlled, and smoke-tested green.", est: 24, sp: 5, labels: ["infra", "devops"] },
    { name: "Implement core integration layer", ac: "All in-scope source/target integrations built and pass contract tests.", est: 56, sp: 13, labels: ["integration", "backend"] },
    { name: "Build migration / transformation jobs", ac: "Migration jobs run end-to-end against a full data snapshot with reconciliation under tolerance.", est: 48, sp: 13, labels: ["data", "migration"] },
    { name: "Develop user-facing screens", ac: "All P0 screens implemented to design; accessibility checks pass; reviewed in demo.", est: 40, sp: 8, labels: ["frontend"] },
    { name: "Wire monitoring & alerting", ac: "Dashboards and alerts cover the critical path; on-call runbook drafted.", est: 16, sp: 3, labels: ["observability", "devops"] },
    { name: "Execute system integration testing (SIT)", ac: "SIT cycle complete; all P0/P1 defects closed or waived with sign-off.", est: 44, sp: 8, labels: ["qa", "testing"] },
    { name: "Security & control review", ac: "Penetration test and control review passed; no open high findings.", est: 20, sp: 5, labels: ["security", "blocked"] },
    { name: "Build-phase steerco demo", ac: "Release candidate demoed to steerco; exit-to-cutover decision recorded.", est: 8, sp: 2, labels: ["governance", "demo"] },
  ],
  Cutover: [
    { name: "Author cutover runbook", ac: "Step-by-step runbook with timings, owners, and rollback points reviewed by all leads.", est: 24, sp: 5, labels: ["cutover", "runbook"] },
    { name: "Run cutover dress rehearsal", ac: "Full rehearsal executed in stage; timings within window; issues logged and triaged.", est: 32, sp: 8, labels: ["cutover", "rehearsal"] },
    { name: "Prepare rollback & contingency plan", ac: "Rollback tested; go/no-go criteria and decision tree signed off by sponsor.", est: 16, sp: 5, labels: ["cutover", "risk"] },
    { name: "Execute production cutover", ac: "Production cutover completed within the approved window; reconciliation passes.", est: 40, sp: 13, labels: ["cutover", "blocked"] },
    { name: "Run hypercare & defect triage", ac: "Two-week hypercare staffed; severity-1 incidents resolved within SLA.", est: 36, sp: 8, labels: ["hypercare", "support"] },
    { name: "Decommission legacy components", ac: "Legacy systems shut down per the decommission checklist; cost savings booked.", est: 20, sp: 5, labels: ["decommission"] },
    { name: "Operational handover to BAU", ac: "Support model, runbooks, and on-call rota accepted by the operations lead.", est: 16, sp: 3, labels: ["handover", "governance"] },
  ],
};

let taskForDeletion = null;
let blockerByMilestone = {}; // remember a task to chain a blocked_by from

for (const [pi, proj] of projects.entries()) {
  for (let m = 0; m < MILESTONE_BLUEPRINT.length; m++) {
    const bp = MILESTONE_BLUEPRINT[m];
    const msTarget = days(-30 + m * 30);
    const ms = await ins("milestones", {
      workspace_id: W, project_id: proj.id, name: bp.name,
      target_date: msTarget, status: MS[(pi + m) % MS.length],
      completion_pct: bp.completion_pct, sort_order: m,
      description: bp.description,
      deliverable: bp.deliverable,
      start_date: days(-40 + m * 30),
      baseline_target_date: days(-35 + m * 30), // baseline slightly ahead of current target → visible slip
      actual_date: bp.status === "completed" ? days(-32 + m * 30) : null,
    });

    // vary how many tasks per milestone (5-8) so registers feel uneven/real
    const templates = TASK_TEMPLATES[bp.name];
    const count = 5 + ((pi + m) % 4); // 5..8
    let prevTaskInMs = null;
    for (let t = 0; t < count && t < templates.length; t++) {
      const tpl = templates[t];
      const [label, type] = ST[(pi + m + t) % ST.length];
      const isBlocked = tpl.labels.includes("blocked");
      const task = await ins("tasks", {
        workspace_id: W, project_id: proj.id, milestone_id: ms.id,
        name: tpl.name,
        description: tpl.ac.length > 0
          ? `Workstream task under the ${bp.name} milestone for ${proj.name}.`
          : null,
        status: label, status_type: type, priority: PRI[(t + pi) % 4],
        completion_pct: type === "completed" ? 100 : type === "started" ? 45 : 0,
        start_date: days(-20 + t * 5), due_date: days(t * 7), sort_order: t,
        acceptance_criteria: tpl.ac,
        estimate_hours: tpl.est,
        story_points: tpl.sp,
        labels: tpl.labels,
        // chain a real blocker: a "blocked" task is blocked_by the prior task in the milestone
        blocked_by: isBlocked && prevTaskInMs ? prevTaskInMs.id : null,
      });
      prevTaskInMs = task;
      if (isBlocked) blockerByMilestone[`${pi}-${m}`] = task.id;
      if (pi === 1 && m === 0 && t === 0) taskForDeletion = task;
    }
  }
}
console.log("milestones + tasks done");

// ── risks (PMBOK register: probability/impact, strategy, category, trigger, residual) ──
const RISKS = [
  {
    title: "Core-network vendor SLA slippage",
    description: "The converged-core vendor has missed two consecutive integration gates, and their named technical lead rolled off without a backfill. Each slip consumes schedule float on the critical re-homing path, and a third miss would push the cutover into the change-freeze window ahead of the merger deadline. Commercial leverage exists but has not yet been exercised.",
    severity: "high", likelihood: "high", probability_pct: 70, impact_score: 4,
    response_strategy: "transfer", risk_category: "dependencies_third_party", impact_area: "schedule",
    trigger: "Any single integration gate slips more than five business days, or the vendor lead is unavailable for two consecutive ceremonies.",
    residual_risk: "Moderate — even with the SLA escalation and 10% retention held back, some schedule float is consumed; residual exposure remains on the cutover date.",
    mitigation: "Escalate to the master-services SLA with the liquidated-damages clause; hold 10% retention; require a named backfill within five working days.",
    status: "mitigating", category: "Dependencies (Project & 3rd Party)",
  },
  {
    title: "Billing reconciliation defects block cutover",
    description: "The rating engine is producing reconciliation breaks above tolerance on a subset of converted accounts, and the regulated billing-cycle window that the cutover must hit is fixed by MCMC. If the defect rate is not driven below the agreed threshold before the dress rehearsal, the cutover cannot proceed and slips a full billing cycle — a revenue-leakage and compliance exposure.",
    severity: "critical", likelihood: "high", probability_pct: 65, impact_score: 5,
    response_strategy: "mitigate", risk_category: "technology_infrastructure", impact_area: "cost",
    trigger: "Reconciliation break rate stays above 0.5% within ten days of the dress-rehearsal date.",
    residual_risk: "High until the second QA squad lands; after remediation, residual is moderate pending a clean rehearsal run.",
    mitigation: "Stand up a dedicated reconciliation QA squad; daily defect burn-down at steerco; pre-agree a contingency one-cycle slip plan with finance.",
    status: "open", category: "Technology & Infrastructure",
  },
  {
    title: "Final-wave store network re-home dependency",
    description: "The last wave of retail stores depends on the NBC-CORE re-homing completing first. NBC-CORE is amber on vendor gates, so a slip there cascades directly into the retail go-live wave. The retail programme itself is healthy, but it cannot de-risk this externally-owned dependency on its own.",
    severity: "medium", likelihood: "medium", probability_pct: 40, impact_score: 3,
    response_strategy: "accept", risk_category: "dependencies_third_party", impact_area: "schedule",
    trigger: "NBC-CORE re-homing milestone forecast moves past the final retail-wave start date.",
    residual_risk: "Low-moderate — the wave can be re-sequenced to a later window with limited business impact if the dependency slips.",
    mitigation: "Maintain a re-sequenced fallback wave plan; weekly dependency check against NBC-CORE; pre-brief affected store regions.",
    status: "open", category: "Dependencies (Project & 3rd Party)",
  },
  {
    title: "Identity-resolution match rate below target",
    description: "Identity resolution on legacy customer records is matching below the agreed single-customer-view threshold, driven by poor data quality in two older source systems. A low match rate undermines every downstream personalisation use-case and weakens the business case for the CDP. Remediation is data-cleansing heavy and competes for the same scarce data-engineering capacity.",
    severity: "high", likelihood: "medium", probability_pct: 50, impact_score: 4,
    response_strategy: "mitigate", risk_category: "data_information", impact_area: "quality",
    trigger: "Match rate remains below 90% after the second cleansing pass on the two legacy sources.",
    residual_risk: "Moderate — a manual-review tier can lift match rates but adds ongoing operational cost.",
    mitigation: "Targeted cleansing of the two worst sources; tune matching rules; add a manual stewardship tier for low-confidence matches.",
    status: "mitigating", category: "Data & Information Management",
  },
  {
    title: "Super-App store-review rejection risk",
    description: "App-store review guidelines for wallet onboarding and data-consent flows are strict and have shifted recently. A rejection at submission would push the general-availability launch past the marketing-committed date, with reputational and momentum cost given the flagship visibility of this programme.",
    severity: "medium", likelihood: "low", probability_pct: 25, impact_score: 3,
    response_strategy: "avoid", risk_category: "compliance_regulatory", impact_area: "reputation",
    trigger: "Pre-submission policy review flags any wallet or consent flow as non-compliant.",
    residual_risk: "Low — a pre-submission compliance review and a staged rollout largely remove the exposure.",
    mitigation: "Run a pre-submission guideline review with the platform vendor; stage a phased rollout; keep a hotfix lane reserved.",
    status: "accepted", category: "Compliance & Regulatory",
  },
  {
    title: "Zero-trust change fatigue (residual)",
    description: "The zero-trust rollout completed, but the volume of access-policy and posture changes created change fatigue in some business units, with a tail of access exceptions still being rationalised. This is now a managed, closing-out residual rather than an active delivery threat.",
    severity: "low", likelihood: "low", probability_pct: 15, impact_score: 2,
    response_strategy: "accept", risk_category: "change_stakeholder", impact_area: "scope",
    trigger: "Access-exception backlog stops trending down for two consecutive weeks.",
    residual_risk: "Low — handled via BAU access governance; no programme action required.",
    mitigation: "Hand exception rationalisation to BAU access governance; monthly trend review for one quarter.",
    status: "closed", category: "Change Management & Stakeholder Alignment",
  },
];

// ── issues (RAID-log parity: severity, category, impact, ETA, lifecycle) ──
const ISSUES = [
  {
    title: "UAT defect backlog exceeding burn-down rate",
    description: "Open UAT defects on the core re-homing workstream are being raised faster than they are closed, and the trend has held for three sprints. Several are clustered in the routing-policy area, suggesting a systemic configuration gap rather than isolated bugs.",
    impact: "If the backlog is not arrested, the build-phase exit gate slips, which in turn compresses the already-tight cutover rehearsal window.",
    priority: "high", severity: "high", issue_category: "technical_defect",
    status: "open", resolution: null, resolution_eta: days(14),
  },
  {
    title: "Cutover window conflicts with retail go-live",
    description: "The billing cutover window and a retail go-live wave were independently scheduled into the same weekend, and both need the shared network-operations bridge. Only one change of this blast radius can be safely run at a time.",
    impact: "Running both concurrently risks contention on the NOC bridge and a confused rollback picture; one must move, affecting at least one programme's committed date.",
    priority: "urgent", severity: "critical", issue_category: "dependency_delay",
    status: "in_progress", resolution: "Change board to arbitrate; proposing to move the retail wave by one week.", resolution_eta: days(5),
  },
  {
    title: "Test-data shortfall for migration dress rehearsal",
    description: "A production-representative data set for the migration dress rehearsal is not yet available because the data-masking pipeline is incomplete. Synthetic data does not exercise the legacy edge-cases that the reconciliation logic must handle.",
    impact: "The dress rehearsal cannot fully validate reconciliation, leaving a blind spot going into the real cutover.",
    priority: "high", severity: "high", issue_category: "data_quality",
    status: "open", resolution: null, resolution_eta: days(10),
  },
  {
    title: "Integration timeout on consent-API under load",
    description: "Under representative load, the consent-aware CDP serving API intermittently times out on identity-resolution lookups against the largest source system. The behaviour was reproduced in performance testing and traced to an un-indexed join.",
    impact: "Personalisation calls would degrade at peak, hurting the Super-App experience that depends on this API.",
    priority: "medium", severity: "medium", issue_category: "technical_defect",
    status: "resolved", resolution: "Added the missing composite index and a read-through cache; p99 latency now within SLA.", resolution_eta: days(-3), resolved_at: days(-2),
  },
  {
    title: "Training gap for store staff on new POS",
    description: "Early-wave stores reported that floor staff were not confident on the refund and stock-adjustment flows of the new POS, leading to longer queues in the first days post go-live.",
    impact: "Slower transactions and a dip in customer experience during the store-transition window; risk of staff workarounds.",
    priority: "medium", severity: "medium", issue_category: "operational_bottleneck",
    status: "in_progress", resolution: "Added a short refresher module and floor-walker support for the first 48 hours of each wave.", resolution_eta: days(7),
  },
  {
    title: "Zero-trust sign-off documentation pending",
    description: "All zero-trust controls passed the independent assessment, but the final signed control-attestation pack was outstanding pending two stakeholder approvals.",
    impact: "Programme could not formally close and book benefits until the attestation pack was complete.",
    priority: "low", severity: "low", issue_category: "stakeholder_conflict",
    status: "resolved", resolution: "Both approvals obtained; attestation pack archived in the Trust Center; programme moved to closeout.", resolution_eta: days(-8), resolved_at: days(-6),
  },
];

for (const [i, proj] of projects.entries()) {
  const r = RISKS[i];
  await ins("risks", {
    workspace_id: W, project_id: proj.id, owner_id: owner,
    title: r.title, description: r.description,
    severity: r.severity, likelihood: r.likelihood,
    probability_pct: r.probability_pct, impact_score: r.impact_score,
    response_strategy: r.response_strategy, risk_category: r.risk_category, impact_area: r.impact_area,
    trigger: r.trigger, residual_risk: r.residual_risk,
    category: r.category, mitigation: r.mitigation, status: r.status,
    raised_at: days(-15), due_date: days(20),
  });

  const iss = ISSUES[i];
  await ins("issues", {
    workspace_id: W, project_id: proj.id, owner_id: owner,
    title: iss.title, description: iss.description,
    priority: iss.priority, severity: iss.severity, issue_category: iss.issue_category,
    impact: iss.impact, resolution: iss.resolution,
    status: iss.status, raised_at: days(-10), due_date: days(10),
    resolution_eta: iss.resolution_eta, resolved_at: iss.resolved_at ?? null,
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

// ── budgets + expenses + time entries (EVM-ready spread, actuals + reserves) ──
// [planned, committed, actual] — actual tuned so CPI/SPI tell a story across the portfolio.
const budgets = [
  [1_200_000, 740_000, 790_000],  // NBC-CORE: slightly over on AC vs EV → CPI < 1
  [900_000, 610_000, 540_000],    // NBC-BILL: behind schedule (low completion) → SPI < 1
  [500_000, 300_000, 300_000],    // NBC-RET: healthy
  [800_000, 350_000, 410_000],    // DX-DATA: AC creeping ahead of progress
  [1_500_000, 1_050_000, 1_020_000], // DX-APP: healthy, on track
  [400_000, 400_000, 398_000],    // DX-SEC: complete, on budget
];
for (const [i, proj] of projects.entries()) {
  const [planned, committed, actual] = budgets[i];
  await ins("project_budget", {
    project_id: proj.id, workspace_id: W,
    planned_amount: planned, committed_amount: committed, actual_amount: actual,
    contingency_reserve: Math.round(planned * 0.05),
    management_reserve: Math.round(planned * 0.03),
    currency: "MYR",
  });
  await ins("expenses", { workspace_id: W, project_id: proj.id, description: "Vendor licences", amount: committed * 0.3, category: "Software", incurred_on: days(-20) });
  await ins("expenses", { workspace_id: W, project_id: proj.id, description: "Professional services (integration partner)", amount: committed * 0.22, category: "Services", incurred_on: days(-12) });
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
