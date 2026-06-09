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
    code: "ERP-EMEA", name: "S/4HANA Core Rollout — EMEA", program: "Global ERP Consolidation",
    rag_status: "amber", completion_pct: 62, is_locked: true, lock_reason: "Baseline frozen for steerco",
    phase: "execution",
    business_case: "Meridian Global runs eleven legacy ERP instances across EMEA at a combined run-rate of $14M/yr in licence, hosting, and reconciliation cost. Consolidating the region onto a single S/4HANA core removes the duplicate OPEX, retires three end-of-life ECC instances, and is the dependency gate for every downstream finance and supply-chain initiative in the portfolio.",
    objective: "Migrate all EMEA operating companies onto the unified S/4HANA core, decommission the legacy ECC instances, and establish a single regional finance and logistics system of record — with zero unplanned period-close disruption during cutover.",
    scope_summary: "In scope: financials, procurement, and order-to-cash convergence across the EMEA operating companies, plus legacy ECC decommission. Out of scope: APAC and Americas templates (separate waves) and the standalone treasury platform.",
    sponsor: "Sofia Almeida (Group CFO)",
    project_manager: "Elena Rossi",
    health_commentary: "Amber: systems-integrator delivery gates are slipping and float is being consumed, but no scope or budget breach yet. Holding amber pending the SLA escalation outcome.",
  },
  {
    code: "FIN-MIG", name: "Finance Data Migration — Global", program: "Global ERP Consolidation",
    rag_status: "red", completion_pct: 38,
    phase: "execution",
    business_case: "Legacy finance master and transactional data cannot be carried into the new ERP cores without cleansing and harmonisation; running parallel ledgers past the fiscal-year cutover risks a material misstatement and an external-audit finding. A single, reconciled global finance data set is mandatory for the consolidation and unlocks $6M/yr in close-acceleration and reconciliation savings.",
    objective: "Migrate and reconcile all general-ledger, vendor, and customer master data into the unified finance model within one fiscal-year close window, with tied-out balances and no financial leakage.",
    scope_summary: "In scope: master-data harmonisation, GL conversion, open-item migration, and finance reconciliation. Out of scope: the order-to-cash front-end (CDP-CORE) and historical statutory-archive migration.",
    sponsor: "Sofia Almeida (Group CFO)",
    project_manager: "Elena Rossi",
    health_commentary: "Red: reconciliation defects in the GL conversion engine are blocking the migration dress-rehearsal, and the fiscal-year close window is fixed. Recovery plan tabled at steerco; needs an extra reconciliation QA squad.",
  },
  {
    code: "CLD-APAC", name: "Datacenter Exit to Cloud — APAC", program: "Cloud & Platform Modernization",
    rag_status: "green", completion_pct: 81,
    phase: "execution",
    business_case: "Meridian Global operates two ageing leased datacenters across APAC running incompatible virtualisation and storage estates. Migrating these workloads to the public cloud exits the lease liabilities, standardises the regional operating model, and reduces infrastructure run cost while improving resilience.",
    objective: "Migrate all in-scope APAC workloads to the cloud landing zone in waves, exit both leased datacenters, and achieve under 30 minutes of cutover downtime per workload with full data reconciliation.",
    scope_summary: "In scope: workload migration, landing-zone build, network re-homing, and datacenter exit. Out of scope: the e-commerce estate (ECM-WEB) and the regional analytics warehouse.",
    sponsor: "Hiroshi Tanaka (Regional COO, APAC)",
    project_manager: "Elena Rossi",
    health_commentary: "Green: wave 1-3 workloads live and stable, ahead of the migration curve. Watching only the final-wave network re-home, which depends on ERP-EMEA shared connectivity.",
  },
  {
    code: "CDP-CORE", name: "Customer Data Platform", program: "Cloud & Platform Modernization",
    rag_status: "amber", completion_pct: 47,
    phase: "execution",
    business_case: "Customer data is fragmented across 11 regional source systems, blocking any single-customer-view, personalisation, or churn modelling. A unified CDP is the foundational data asset for the modernization programme and the precondition for the global e-commerce replatform.",
    objective: "Stand up a governed customer data platform with a resolved single-customer-view across all source systems, exposed via a consent-aware API.",
    scope_summary: "In scope: ingestion, identity resolution, consent management, and the CDP serving API. Out of scope: ML model training and marketing-automation tooling.",
    sponsor: "Sofia Almeida (Group CFO)",
    project_manager: "Elena Rossi",
    health_commentary: "Amber: identity-resolution match rates are below target on legacy records and the data-engineering lead is over-allocated across three programmes. Resourcing flagged as a clash.",
  },
  {
    code: "ECM-WEB", name: "Global E-Commerce Replatform", program: "Cloud & Platform Modernization",
    rag_status: "green", completion_pct: 73,
    phase: "execution",
    business_case: "Customers transact through five disconnected regional storefronts with low conversion and high maintenance cost. A single global commerce platform consolidating catalogue, checkout, and payments raises conversion, opens a cross-region merchandising channel, and is the flagship customer-facing proof of the modernization programme.",
    objective: "Launch a unified global e-commerce platform (catalogue + checkout + payments) to general availability, hitting the agreed conversion and uptime targets.",
    scope_summary: "In scope: storefront shell, catalogue, checkout, payment onboarding, and the CDP-backed personalisation surface. Out of scope: third-party marketplace integrations (phase 2).",
    sponsor: "Hiroshi Tanaka (Regional COO, APAC)",
    project_manager: "Elena Rossi",
    health_commentary: "Green: beta cohort metrics are above target and the launch-readiness track is on schedule. Dependency on CDP-CORE personalisation is the only watch item.",
  },
  {
    code: "IAM-SEC", name: "Identity & Access Modernization", program: "Cloud & Platform Modernization",
    rag_status: "complete", completion_pct: 100,
    phase: "closing",
    business_case: "The multi-region estate inherited fragmented directories and inconsistent access controls — an audit and breach exposure. A modern identity-and-access architecture (single identity fabric, conditional access, continuous verification) was mandated by the board risk committee.",
    objective: "Roll out the unified identity fabric and conditional access across all corporate and production estates, retire legacy directory trust, and pass the independent control assessment.",
    scope_summary: "In scope: identity-fabric uplift, device posture, conditional-access policy, and legacy directory decommission. Out of scope: customer-facing fraud controls.",
    sponsor: "Sofia Almeida (Group CFO)",
    project_manager: "Elena Rossi",
    health_commentary: "Complete: independent control assessment passed with no major findings; legacy directory trust retired. Programme in closeout / benefits-tracking.",
  },
];
const projects = [];
for (const p of P) {
  projects.push(await ins("projects", {
    workspace_id: W, owner_id: owner, currency: "USD",
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
    title: "Systems-integrator SLA slippage on EMEA build",
    description: "The S/4HANA systems integrator has missed two consecutive build gates, and their named solution lead rolled off without a backfill. Each slip consumes schedule float on the critical conversion path, and a third miss would push the EMEA cutover into the period-close freeze window. Commercial leverage exists under the master-services agreement but has not yet been exercised.",
    severity: "high", likelihood: "high", probability_pct: 70, impact_score: 4,
    response_strategy: "transfer", risk_category: "dependencies_third_party", impact_area: "schedule",
    trigger: "Any single build gate slips more than five business days, or the integrator's solution lead is unavailable for two consecutive ceremonies.",
    residual_risk: "Moderate — even with the SLA escalation and 10% retention held back, some schedule float is consumed; residual exposure remains on the cutover date.",
    mitigation: "Escalate under the master-services SLA with the liquidated-damages clause; hold 10% retention; require a named backfill within five working days.",
    status: "mitigating", category: "Dependencies (Project & 3rd Party)",
  },
  {
    title: "Finance reconciliation defects block migration cutover",
    description: "The GL conversion engine is producing reconciliation breaks above tolerance on a subset of converted accounts, and the fiscal-year close window that the migration must hit is fixed by group finance. If the defect rate is not driven below the agreed threshold before the dress rehearsal, the cutover cannot proceed and slips a full close cycle — a financial-misstatement and external-audit exposure.",
    severity: "critical", likelihood: "high", probability_pct: 65, impact_score: 5,
    response_strategy: "mitigate", risk_category: "technology_infrastructure", impact_area: "cost",
    trigger: "Reconciliation break rate stays above 0.5% within ten days of the dress-rehearsal date.",
    residual_risk: "High until the second QA squad lands; after remediation, residual is moderate pending a clean rehearsal run.",
    mitigation: "Stand up a dedicated reconciliation QA squad; daily defect burn-down at steerco; pre-agree a contingency one-cycle slip plan with finance.",
    status: "open", category: "Technology & Infrastructure",
  },
  {
    title: "Final-wave cloud network re-home dependency",
    description: "The last wave of APAC workloads depends on the ERP-EMEA shared connectivity re-homing completing first. ERP-EMEA is amber on integrator gates, so a slip there cascades directly into the final datacenter-exit wave. The cloud programme itself is healthy, but it cannot de-risk this externally-owned dependency on its own.",
    severity: "medium", likelihood: "medium", probability_pct: 40, impact_score: 3,
    response_strategy: "accept", risk_category: "dependencies_third_party", impact_area: "schedule",
    trigger: "ERP-EMEA connectivity re-homing milestone forecast moves past the final datacenter-exit wave start date.",
    residual_risk: "Low-moderate — the wave can be re-sequenced to a later window with limited business impact if the dependency slips.",
    mitigation: "Maintain a re-sequenced fallback wave plan; weekly dependency check against ERP-EMEA; pre-brief affected regional ops teams.",
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
    title: "E-commerce payment-compliance launch risk",
    description: "PCI-DSS and regional payment-compliance requirements for the new checkout and payment-onboarding flows are strict and have shifted recently. A compliance gate failure at launch readiness would push the general-availability launch past the merchandising-committed date, with reputational and momentum cost given the flagship visibility of this programme.",
    severity: "medium", likelihood: "low", probability_pct: 25, impact_score: 3,
    response_strategy: "avoid", risk_category: "compliance_regulatory", impact_area: "reputation",
    trigger: "Pre-launch compliance review flags any checkout or payment-onboarding flow as non-compliant.",
    residual_risk: "Low — a pre-launch compliance review and a staged regional rollout largely remove the exposure.",
    mitigation: "Run a pre-launch PCI review with the payments partner; stage a phased regional rollout; keep a hotfix lane reserved.",
    status: "accepted", category: "Compliance & Regulatory",
  },
  {
    title: "Identity-modernization change fatigue (residual)",
    description: "The identity-and-access rollout completed, but the volume of access-policy and conditional-access changes created change fatigue in some business units, with a tail of access exceptions still being rationalised. This is now a managed, closing-out residual rather than an active delivery threat.",
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
    description: "Open UAT defects on the EMEA financials workstream are being raised faster than they are closed, and the trend has held for three sprints. Several are clustered in the procurement-configuration area, suggesting a systemic template gap rather than isolated bugs.",
    impact: "If the backlog is not arrested, the build-phase exit gate slips, which in turn compresses the already-tight cutover rehearsal window.",
    priority: "high", severity: "high", issue_category: "technical_defect",
    status: "open", resolution: null, resolution_eta: days(14),
  },
  {
    title: "Migration cutover window conflicts with cloud exit wave",
    description: "The finance migration cutover window and an APAC datacenter-exit wave were independently scheduled into the same weekend, and both need the shared change-management bridge. Only one change of this blast radius can be safely run at a time.",
    impact: "Running both concurrently risks contention on the change bridge and a confused rollback picture; one must move, affecting at least one programme's committed date.",
    priority: "urgent", severity: "critical", issue_category: "dependency_delay",
    status: "in_progress", resolution: "Change board to arbitrate; proposing to move the datacenter-exit wave by one week.", resolution_eta: days(5),
  },
  {
    title: "Test-data shortfall for cloud migration dress rehearsal",
    description: "A production-representative data set for the workload migration dress rehearsal is not yet available because the data-masking pipeline is incomplete. Synthetic data does not exercise the legacy edge-cases that the reconciliation logic must handle.",
    impact: "The dress rehearsal cannot fully validate reconciliation, leaving a blind spot going into the real cutover.",
    priority: "high", severity: "high", issue_category: "data_quality",
    status: "open", resolution: null, resolution_eta: days(10),
  },
  {
    title: "Integration timeout on consent-API under load",
    description: "Under representative load, the consent-aware CDP serving API intermittently times out on identity-resolution lookups against the largest source system. The behaviour was reproduced in performance testing and traced to an un-indexed join.",
    impact: "Personalisation calls would degrade at peak, hurting the e-commerce storefront experience that depends on this API.",
    priority: "medium", severity: "medium", issue_category: "technical_defect",
    status: "resolved", resolution: "Added the missing composite index and a read-through cache; p99 latency now within SLA.", resolution_eta: days(-3), resolved_at: days(-2),
  },
  {
    title: "Training gap for support staff on new checkout flows",
    description: "Early-region pilots reported that customer-support agents were not confident on the refund and order-adjustment flows of the new commerce platform, leading to longer handle times in the first days post go-live.",
    impact: "Slower resolution and a dip in customer experience during the region-transition window; risk of agent workarounds.",
    priority: "medium", severity: "medium", issue_category: "operational_bottleneck",
    status: "in_progress", resolution: "Added a short refresher module and floor-walker support for the first 48 hours of each region launch.", resolution_eta: days(7),
  },
  {
    title: "Identity sign-off documentation pending",
    description: "All identity-and-access controls passed the independent assessment, but the final signed control-attestation pack was outstanding pending two stakeholder approvals.",
    impact: "Programme could not formally close and book benefits until the attestation pack was complete.",
    priority: "low", severity: "low", issue_category: "stakeholder_conflict",
    status: "resolved", resolution: "Both approvals obtained; attestation pack archived in the Trust Center; programme moved to closeout.", resolution_eta: days(-8), resolved_at: days(-6),
  },
];

for (const [i, proj] of projects.entries()) {
  const r = RISKS[i];
  await ins("risks", {
    workspace_id: W, project_id: proj.id, owner_id: owner,
    reference_id: `R-${String(i + 1).padStart(3, "0")}`,
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
    reference_id: `ISS-${String(i + 1).padStart(3, "0")}`,
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
  { name: "Elena Rossi", role_title: "Programme Lead", cost_rate: 220, capacity_hours_per_week: 40 },
  { name: "Marcus Bauer", role_title: "Solution Architect", cost_rate: 260, capacity_hours_per_week: 40 },
  { name: "Priya Nair", role_title: "Data Engineer", cost_rate: 180, capacity_hours_per_week: 40 },
  { name: "Daniel Okafor", role_title: "QA Lead", cost_rate: 160, capacity_hours_per_week: 40 },
  { name: "Carlos Mendes", role_title: "Cloud Engineer", cost_rate: 190, capacity_hours_per_week: 40 },
];
const members = [];
for (const p of people) members.push(await ins("resource_members", { workspace_id: W, ...p }));
// Marcus Bauer (index 1) is over-allocated across 3 projects = 140%
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
  reference_id: "CL-001",
  title: `Over-allocation: ${members[1].name} (140%)`, resource_member_id: members[1].id,
  window_start: days(-14), window_end: days(28), owner_id: owner,
  resolution: null,
});
await ins("clashes", {
  workspace_id: W, type: "schedule", severity: "medium", status: "investigating",
  reference_id: "CL-002",
  title: "Cutover window overlap: Finance Migration vs Cloud Exit", project_a_id: projects[1].id, project_b_id: projects[2].id,
  window_start: days(18), window_end: days(25), owner_id: owner,
});
console.log("clashes done");

// ── budgets + expenses + time entries (EVM-ready spread, actuals + reserves) ──
// [planned, committed, actual] — actual tuned so CPI/SPI tell a story across the portfolio.
// SPI is schedule-aware: PV = BAC × (elapsed / baseline_duration). Baseline = days(-90)..days(45)
// → 135-day span; as of today (day 0) elapsed = 90 days → plannedSchedulePct ≈ 66.7%.
// FIN-MIG: completion 38% vs planned 66.7% → SPI ≈ 0.57 (genuinely behind schedule).
const budgets = [
  [8_000_000, 4_900_000, 5_250_000],  // ERP-EMEA: completion 62% vs planned 66.7% → CPI < 1 (AC > EV), SPI ≈ 0.93
  [4_800_000, 3_250_000, 2_880_000],  // FIN-MIG: completion 38% vs planned 66.7% → CPI > 1 (under-spent), SPI ≈ 0.57 (behind schedule)
  [3_200_000, 1_920_000, 1_920_000],  // CLD-APAC: completion 81% vs planned 66.7% → CPI = 1.00, SPI ≈ 1.22 (ahead)
  [3_600_000, 1_580_000, 1_850_000],  // CDP-CORE: completion 47% vs planned 66.7% → CPI < 1 (AC creeping), SPI ≈ 0.71
  [5_400_000, 3_780_000, 3_670_000],  // ECM-WEB: completion 73% vs planned 66.7% → healthy, SPI ≈ 1.10
  [1_200_000, 1_200_000, 1_194_000],  // IAM-SEC: complete (100%) → SPI ≈ 1.50, on budget
];
for (const [i, proj] of projects.entries()) {
  const [planned, committed, actual] = budgets[i];
  await ins("project_budget", {
    project_id: proj.id, workspace_id: W,
    planned_amount: planned, committed_amount: committed, actual_amount: actual,
    contingency_reserve: Math.round(planned * 0.05),
    management_reserve: Math.round(planned * 0.03),
    currency: "USD",
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
// Reference a real risk id so the row links to its target (audit_log is
// append-only — a null target_id can never be corrected after the fact).
const firstRisk = (await db.from("risks").select("id").eq("workspace_id", W).order("reference_id").limit(1).maybeSingle()).data;
const auditRows = [
  { action: "project.create", target_type: "project", target_id: projects[0].id },
  { action: "project.lock", target_type: "project", target_id: projects[0].id },
  { action: "task.update", target_type: "task", target_id: taskForDeletion?.id },
  { action: "risk.create", target_type: "risk", target_id: firstRisk?.id ?? projects[0].id },
  { action: "task.delete_requested", target_type: "task", target_id: taskForDeletion?.id },
];
for (const a of auditRows) {
  await db.from("audit_log").insert({ workspace_id: W, actor_type: "user", actor_id: owner, actor_label: "Jordan Hale", ...a });
}

// Projects flagged RAG 'complete' should read as finished. Project completion is
// now a task rollup (migration 0021), so mark their tasks + milestones done and
// the rollup trigger lands the project at 100%.
const completeProjects = (await db.from("projects").select("id").eq("workspace_id", W).eq("rag_status", "complete")).data ?? [];
for (const proj of completeProjects) {
  await db.from("tasks").update({ status_type: "completed", completion_pct: 100 }).eq("project_id", proj.id).neq("status_type", "canceled");
  await db.from("milestones").update({ status: "complete", completion_pct: 100 }).eq("project_id", proj.id);
}

// Task assignment is handled by scripts/seed-people-link.mjs (run after
// seed-members.mjs): it links login profiles ↔ resource_members and assigns
// tasks to members, since tasks.assignee_id -> resource_members(id) (migration 0019).

console.log("\n✓ Seed complete — demo workspace is rich and ready.");
console.log("  next: seed-members.mjs · seed-change-control.mjs · seed-people-link.mjs · seed-documents.mjs · seed-document-files.mjs · seed-baselines.mjs");
