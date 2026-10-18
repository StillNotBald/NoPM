// NoPM — seed governance documents for the 'demo' workspace.
// Idempotent: clears existing documents for the workspace then reseeds.
// Requires the 20260608000015_documents.sql migration to be applied first.
//
// Run:  node scripts/seed-documents.mjs
import { createClient } from "@supabase/supabase-js";
import { loadEnv, requireEnv } from "./lib/env.mjs";

// ── env loading (mirrors populate-wave-b.mjs) ────────────────────────────────
const env = requireEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], loadEnv());

// ── admin client (mirrors populate-wave-b.mjs) ───────────────────────────────
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── resolve workspace + projects + owner ──────────────────────────────────────
const W    = (await db.from("workspaces").select("id").eq("slug", "demo").single()).data.id;
const owner = (await db.from("profiles").select("id").eq("workspace_id", W).limit(1).single()).data.id;

const projects = (
  await db.from("projects").select("id,code,name").eq("workspace_id", W).order("created_at")
).data ?? [];

// Build a quick lookup by code for readability below.
const byCode = Object.fromEntries(projects.map((p) => [p.code, p.id]));
console.log("projects found:", projects.map((p) => p.code).join(", "));

// ── idempotent clear ─────────────────────────────────────────────────────────
await db.from("documents").delete().eq("workspace_id", W);
console.log("cleared existing documents");

// ── helpers ───────────────────────────────────────────────────────────────────
let docNum = 0;
const nextRef = () => `DOC-${String(++docNum).padStart(3, "0")}`;

const ins = async (row) => {
  const { data, error } = await db.from("documents").insert(row).select().single();
  if (error) throw new Error(`documents insert failed: ${error.message}`);
  return data;
};

// ── documents ────────────────────────────────────────────────────────────────

// ── ERP-EMEA: S/4HANA Core Rollout — EMEA ───────────────────────────────────
await ins({
  workspace_id: W,
  project_id:   byCode["ERP-EMEA"],
  reference_id: nextRef(),
  folder:       "Charter",
  title:        "ERP-EMEA Project Charter v1.0",
  doc_type:     "charter",
  status:       "approved",
  version:      1,
  summary:      "Approved project charter for the S/4HANA Core Rollout — EMEA programme. Authorises scope, budget, and governance structure.",
  body: `# Project Charter — S/4HANA Core Rollout EMEA

## Purpose
This charter formally authorises the ERP-EMEA programme and grants the project manager authority to apply organisational resources.

## Business Case
Meridian Global operates eleven legacy ERP instances across EMEA at a combined run-rate of **$14M/yr** in licence, hosting, and reconciliation cost. Consolidating the region onto a single S/4HANA core removes duplicate OPEX, retires three end-of-life ECC instances, and gates every downstream finance and supply-chain initiative.

## Objectives
- Migrate all EMEA operating companies onto the unified S/4HANA core.
- Decommission the legacy ECC instances.
- Achieve zero unplanned period-close disruption during cutover.

## Sponsor
Sofia Almeida (Group CFO)

## Project Manager
Elena Rossi

## Budget Authority
$8,000,000 USD (planned). Contingency: 5%. Management reserve: 3%.

## Governance
Monthly Steering Committee. Rebaseline requires written sponsor approval.

## Signatures
Approved by Steering Committee — see Steering Committee Minutes DOC-011.`,
  owner_id:   owner,
  created_by: owner,
});

await ins({
  workspace_id: W,
  project_id:   byCode["ERP-EMEA"],
  reference_id: nextRef(),
  folder:       "RAID",
  title:        "ERP-EMEA RAID Log — Q2 2026",
  doc_type:     "raid",
  status:       "in_review",
  version:      3,
  summary:      "Live RAID log capturing Risks, Assumptions, Issues, and Decisions for the EMEA ERP rollout. Under review by programme lead.",
  body: `# RAID Log — ERP-EMEA Q2 2026

## Risks
| Ref  | Title | Severity | Status |
|------|-------|----------|--------|
| R-001 | Systems-integrator SLA slippage | High | Mitigating |

## Assumptions
- SAP licence procurement completes before build phase gate.
- EMEA operating companies provide data-migration SMEs as agreed.

## Issues
| Ref    | Title | Priority | Status |
|--------|-------|----------|--------|
| ISS-001 | UAT defect backlog exceeding burn-down rate | High | Open |

## Decisions
| Date | Decision | Owner |
|------|----------|-------|
| 2026-05-10 | Adopt a phased cutover by country (Germany first) | Elena Rossi |
| 2026-05-24 | Extend SIT by 2 weeks to absorb defect backlog | Elena Rossi |

_Last updated: 2026-06-08. Pending sign-off from Programme Lead._`,
  owner_id:   owner,
  created_by: owner,
});

await ins({
  workspace_id: W,
  project_id:   byCode["ERP-EMEA"],
  reference_id: nextRef(),
  folder:       "Status Reports",
  title:        "ERP-EMEA Weekly Status Report — W23 2026",
  doc_type:     "status_report",
  status:       "approved",
  version:      1,
  summary:      "RAG: Amber. Schedule float is being consumed by integrator gate slippage. No scope or budget breach. SLA escalation in progress.",
  body: `# ERP-EMEA Weekly Status Report — Week 23, 2026

**RAG Status:** 🟡 Amber
**Completion:** 62%
**Reported by:** Elena Rossi

## Summary
The programme remains Amber. The systems integrator missed its third consecutive build gate this week, consuming a further two days of schedule float. Commercial SLA escalation has been formally triggered. No scope or budget breach has occurred.

## Milestones
| Milestone | Status | Notes |
|-----------|--------|-------|
| Discovery | ✅ Complete | Signed off Q1 |
| Build | 🟡 At Risk | Integrator gate slippage |
| Cutover | ⬜ Not Started | Dependent on Build exit |

## Key Actions
- [ ] SLA escalation response from integrator due 2026-06-12.
- [ ] Revised build schedule to be tabled at next Steerco.
- [ ] Rollback rehearsal window to be re-confirmed with change board.

## Risks & Issues
See RAID Log DOC-002 for full register. Critical watch item: integrator named solution lead still without backfill.`,
  owner_id:   owner,
  created_by: owner,
});

// ── FIN-MIG: Finance Data Migration — Global ─────────────────────────────────
await ins({
  workspace_id: W,
  project_id:   byCode["FIN-MIG"],
  reference_id: nextRef(),
  folder:       "Charter",
  title:        "FIN-MIG Project Charter v1.0",
  doc_type:     "charter",
  status:       "approved",
  version:      1,
  summary:      "Approved project charter authorising the global finance data migration to the unified ERP model.",
  body: `# Project Charter — Finance Data Migration Global

## Purpose
Formal authorisation for the Finance Data Migration programme.

## Business Case
Legacy finance master and transactional data cannot be carried into the new ERP cores without cleansing and harmonisation. Running parallel ledgers past the fiscal-year cutover risks a material misstatement and an external-audit finding. The single, reconciled global finance data set unlocks **$6M/yr** in close-acceleration and reconciliation savings.

## Objectives
- Migrate and reconcile all GL, vendor, and customer master data into the unified finance model.
- Complete within one fiscal-year close window with tied-out balances and no financial leakage.

## Sponsor
Sofia Almeida (Group CFO)

## Project Manager
Elena Rossi

## Budget Authority
$4,800,000 USD planned.

## Governance
Weekly critical-path review. Finance Controller sign-off required on reconciliation.`,
  owner_id:   owner,
  created_by: owner,
});

await ins({
  workspace_id: W,
  project_id:   byCode["FIN-MIG"],
  reference_id: nextRef(),
  folder:       "RAID",
  title:        "FIN-MIG RAID Log — Q2 2026",
  doc_type:     "raid",
  status:       "in_review",
  version:      2,
  summary:      "RAID log for the Finance Data Migration programme. Critical risk: GL reconciliation defects exceeding tolerance. Pending CFO review.",
  body: `# RAID Log — FIN-MIG Q2 2026

## Risks
| Ref  | Title | Severity | Status |
|------|-------|----------|--------|
| R-002 | Finance reconciliation defects block migration cutover | Critical | Open |

## Assumptions
- Fiscal-year close window is fixed and non-negotiable.
- Group Finance provides two reconciliation QA SMEs by 2026-06-15.

## Issues
| Ref    | Title | Priority | Status |
|--------|-------|----------|--------|
| ISS-002 | Migration cutover window conflicts with cloud exit wave | Urgent | In Progress |

## Decisions
| Date | Decision | Owner |
|------|----------|-------|
| 2026-06-01 | Stand up dedicated reconciliation QA squad | Elena Rossi |
| 2026-06-05 | Pre-agree contingency one-cycle slip plan with Finance Controller | Elena Rossi |

_Last updated: 2026-06-08. Pending CFO sign-off._`,
  owner_id:   owner,
  created_by: owner,
});

await ins({
  workspace_id: W,
  project_id:   byCode["FIN-MIG"],
  reference_id: nextRef(),
  folder:       "Status Reports",
  title:        "FIN-MIG Weekly Status Report — W23 2026",
  doc_type:     "status_report",
  status:       "approved",
  version:      1,
  summary:      "RAG: Red. GL reconciliation defects blocking dress rehearsal. Recovery plan tabled. Extra QA squad required urgently.",
  body: `# FIN-MIG Weekly Status Report — Week 23, 2026

**RAG Status:** 🔴 Red
**Completion:** 38%
**Reported by:** Elena Rossi

## Summary
The programme is Red. Reconciliation defects in the GL conversion engine are blocking the migration dress rehearsal. The fiscal-year close window is fixed. Recovery plan has been tabled at steerco. An additional reconciliation QA squad is required urgently.

## Critical Path
- Dress rehearsal blocked until defect rate falls below 0.5%.
- Current defect rate: **2.1%** (tolerance: 0.5%).

## Key Actions
- [ ] Reconciliation QA squad to be resourced and onboarded by 2026-06-15.
- [ ] Daily defect burn-down review chaired by Programme Lead.
- [ ] Contingency slip plan to be signed off by CFO by 2026-06-10.

## Escalation
Formally escalated to Group CFO Sofia Almeida on 2026-06-07.`,
  owner_id:   owner,
  created_by: owner,
});

// ── CLD-APAC: Datacenter Exit to Cloud — APAC ───────────────────────────────
await ins({
  workspace_id: W,
  project_id:   byCode["CLD-APAC"],
  reference_id: nextRef(),
  folder:       "Charter",
  title:        "CLD-APAC Project Charter v1.0",
  doc_type:     "charter",
  status:       "approved",
  version:      1,
  summary:      "Approved project charter for the APAC datacenter exit and cloud migration programme.",
  body: `# Project Charter — Datacenter Exit to Cloud APAC

## Purpose
Authorises the APAC Datacenter Exit programme.

## Business Case
Meridian Global operates two ageing leased datacenters across APAC. Migrating workloads to the public cloud exits lease liabilities, standardises the regional operating model, and reduces infrastructure run cost while improving resilience.

## Objectives
- Migrate all in-scope APAC workloads to the cloud landing zone in waves.
- Exit both leased datacenters.
- Achieve under 30 minutes of cutover downtime per workload with full data reconciliation.

## Sponsor
Hiroshi Tanaka (Regional COO, APAC)

## Project Manager
Elena Rossi

## Budget Authority
$3,200,000 USD planned.`,
  owner_id:   owner,
  created_by: owner,
});

await ins({
  workspace_id: W,
  project_id:   byCode["CLD-APAC"],
  reference_id: nextRef(),
  folder:       "Status Reports",
  title:        "CLD-APAC Weekly Status Report — W23 2026",
  doc_type:     "status_report",
  status:       "approved",
  version:      1,
  summary:      "RAG: Green. Waves 1-3 live and stable. Ahead of migration curve. Only watch item: final-wave network re-home dependency on ERP-EMEA.",
  body: `# CLD-APAC Weekly Status Report — Week 23, 2026

**RAG Status:** 🟢 Green
**Completion:** 81%
**Reported by:** Elena Rossi

## Summary
The programme is Green and ahead of the migration curve. Waves 1-3 workloads are live and stable. The only watch item is the final-wave network re-home, which has a dependency on ERP-EMEA shared connectivity.

## Wave Status
| Wave | Status |
|------|--------|
| Wave 1 | ✅ Live |
| Wave 2 | ✅ Live |
| Wave 3 | ✅ Live |
| Wave 4 (Final) | 🔵 Planning — dependency watch |

## Key Actions
- [ ] Weekly dependency check against ERP-EMEA connectivity milestone.
- [ ] Brief affected regional ops teams on potential re-sequencing.`,
  owner_id:   owner,
  created_by: owner,
});

// ── CDP-CORE: Customer Data Platform ─────────────────────────────────────────
await ins({
  workspace_id: W,
  project_id:   byCode["CDP-CORE"],
  reference_id: nextRef(),
  folder:       "Charter",
  title:        "CDP-CORE Project Charter v1.0",
  doc_type:     "charter",
  status:       "approved",
  version:      1,
  summary:      "Approved project charter for the Customer Data Platform programme.",
  body: `# Project Charter — Customer Data Platform

## Purpose
Authorises the Customer Data Platform programme.

## Business Case
Customer data is fragmented across 11 regional source systems, blocking single-customer-view, personalisation, and churn modelling. The unified CDP is the foundational data asset for the modernization programme and the precondition for the global e-commerce replatform.

## Objectives
- Stand up a governed CDP with a resolved single-customer-view across all source systems.
- Expose via a consent-aware API.

## Sponsor
Sofia Almeida (Group CFO)

## Project Manager
Elena Rossi

## Budget Authority
$3,600,000 USD planned.`,
  owner_id:   owner,
  created_by: owner,
});

await ins({
  workspace_id: W,
  project_id:   byCode["CDP-CORE"],
  reference_id: nextRef(),
  folder:       "RAID",
  title:        "CDP-CORE RAID Log — Q2 2026",
  doc_type:     "raid",
  status:       "in_review",
  version:      1,
  summary:      "RAID log for the CDP programme. Key risk: identity-resolution match rate below target. Data engineering capacity clash flagged.",
  body: `# RAID Log — CDP-CORE Q2 2026

## Risks
| Ref  | Title | Severity | Status |
|------|-------|----------|--------|
| R-004 | Identity-resolution match rate below target | High | Mitigating |

## Assumptions
- Source systems provide agreed data extract in the specified format.
- Priya Nair (Data Engineer) is available 80% on CDP through Q2.

## Issues
| Ref    | Title | Priority | Status |
|--------|-------|----------|--------|
| ISS-004 | Integration timeout on consent-API under load | Medium | Resolved |

## Decisions
| Date | Decision | Owner |
|------|----------|-------|
| 2026-05-20 | Add manual stewardship tier for low-confidence identity matches | Elena Rossi |

_Last updated: 2026-06-08. Pending data lead sign-off._`,
  owner_id:   owner,
  created_by: owner,
});

await ins({
  workspace_id: W,
  project_id:   byCode["CDP-CORE"],
  reference_id: nextRef(),
  folder:       "Status Reports",
  title:        "CDP-CORE Weekly Status Report — W23 2026",
  doc_type:     "status_report",
  status:       "approved",
  version:      1,
  summary:      "RAG: Amber. Identity-resolution match rates below target. Data engineering lead over-allocated. Resourcing clash escalated.",
  body: `# CDP-CORE Weekly Status Report — Week 23, 2026

**RAG Status:** 🟡 Amber
**Completion:** 47%
**Reported by:** Elena Rossi

## Summary
Identity-resolution match rates are below target on legacy records due to poor data quality in two older source systems. The data-engineering lead is over-allocated across three programmes — this has been flagged as a resource clash (CL-001).

## Key Metrics
- Match rate target: **≥ 90%**
- Current match rate: **76%**

## Key Actions
- [ ] Targeted cleansing of two worst source systems.
- [ ] Escalate resource clash to Portfolio level (see CL-001).
- [ ] Tune matching rules and add stewardship tier.`,
  owner_id:   owner,
  created_by: owner,
});

// ── ECM-WEB: Global E-Commerce Replatform ────────────────────────────────────
await ins({
  workspace_id: W,
  project_id:   byCode["ECM-WEB"],
  reference_id: nextRef(),
  folder:       "Charter",
  title:        "ECM-WEB Project Charter v1.0",
  doc_type:     "charter",
  status:       "approved",
  version:      1,
  summary:      "Approved project charter for the Global E-Commerce Replatform. Authorises unified storefront, checkout, and payments.",
  body: `# Project Charter — Global E-Commerce Replatform

## Purpose
Authorises the ECM-WEB programme.

## Business Case
Customers transact through five disconnected regional storefronts with low conversion and high maintenance cost. A single global commerce platform raises conversion, opens a cross-region merchandising channel, and is the flagship customer-facing proof of the modernization programme.

## Objectives
- Launch a unified global e-commerce platform (catalogue + checkout + payments) to general availability.
- Hit the agreed conversion and uptime targets.

## Sponsor
Hiroshi Tanaka (Regional COO, APAC)

## Project Manager
Elena Rossi

## Budget Authority
$5,400,000 USD planned.`,
  owner_id:   owner,
  created_by: owner,
});

await ins({
  workspace_id: W,
  project_id:   byCode["ECM-WEB"],
  reference_id: nextRef(),
  folder:       "Status Reports",
  title:        "ECM-WEB Weekly Status Report — W23 2026",
  doc_type:     "status_report",
  status:       "approved",
  version:      1,
  summary:      "RAG: Green. Beta cohort metrics above target. Launch readiness on schedule. Only watch item: CDP-CORE personalisation dependency.",
  body: `# ECM-WEB Weekly Status Report — Week 23, 2026

**RAG Status:** 🟢 Green
**Completion:** 73%
**Reported by:** Elena Rossi

## Summary
Beta cohort metrics are above target and the launch-readiness track is on schedule. The CDP-CORE personalisation dependency is the only watch item.

## Beta Metrics
- Conversion rate: **+18%** vs legacy (target: +15%)
- Checkout abandonment: **-11%** (target: -10%)

## Key Actions
- [ ] Monitor CDP-CORE match rate weekly — personalisation accuracy depends on it.
- [ ] PCI compliance pre-launch review with payments partner scheduled for 2026-06-20.`,
  owner_id:   owner,
  created_by: owner,
});

// ── IAM-SEC: Identity & Access Modernization (closing) ───────────────────────
await ins({
  workspace_id: W,
  project_id:   byCode["IAM-SEC"],
  reference_id: nextRef(),
  folder:       "Charter",
  title:        "IAM-SEC Project Charter v1.0",
  doc_type:     "charter",
  status:       "approved",
  version:      1,
  summary:      "Approved project charter for the Identity & Access Modernization programme. Programme now complete.",
  body: `# Project Charter — Identity & Access Modernization

## Purpose
Authorises the IAM-SEC programme.

## Business Case
The multi-region estate inherited fragmented directories and inconsistent access controls — an audit and breach exposure. A modern identity-and-access architecture was mandated by the board risk committee.

## Objectives
- Roll out the unified identity fabric and conditional access across all corporate and production estates.
- Retire legacy directory trust and pass the independent control assessment.

## Sponsor
Sofia Almeida (Group CFO)

## Outcome
Programme complete. Independent control assessment passed with no major findings. Legacy directory trust retired. Programme in closeout and benefits-tracking.`,
  owner_id:   owner,
  created_by: owner,
});

// ── Workspace-level: Change Control Log ──────────────────────────────────────
await ins({
  workspace_id: W,
  project_id:   null,   // workspace-level
  reference_id: nextRef(),
  folder:       "Change Control",
  title:        "Portfolio Change Control Log — Q2 2026",
  doc_type:     "other",
  status:       "approved",
  version:      2,
  summary:      "Master log of all approved and pending change requests across the Meridian Global portfolio for Q2 2026.",
  body: `# Portfolio Change Control Log — Q2 2026

| Ref | Project | Change Title | Requester | Status | Impact |
|-----|---------|--------------|-----------|--------|--------|
| CR-001 | ERP-EMEA | Extend SIT by 2 weeks | Elena Rossi | Approved | +2 weeks schedule; no cost |
| CR-002 | FIN-MIG | Add reconciliation QA squad | Elena Rossi | Approved | +$120,000 cost |
| CR-003 | CLD-APAC | Re-sequence wave 4 by 3 weeks | Elena Rossi | In Review | +3 weeks schedule |

_Maintained by: Programme PMO. Updated: 2026-06-08._`,
  owner_id:   owner,
  created_by: owner,
});

// ── Workspace-level: Change Request (in_review) ───────────────────────────────
await ins({
  workspace_id: W,
  project_id:   byCode["CLD-APAC"],
  reference_id: nextRef(),
  folder:       "Change Control",
  title:        "CR-003: Re-sequence CLD-APAC Wave 4 by 3 Weeks",
  doc_type:     "change_request",
  status:       "in_review",
  version:      1,
  summary:      "Change request to re-sequence the final APAC datacenter-exit wave by 3 weeks pending ERP-EMEA connectivity dependency resolution.",
  body: `# Change Request — CR-003

**Project:** CLD-APAC — Datacenter Exit to Cloud APAC
**Requester:** Elena Rossi
**Date:** 2026-06-07
**Status:** In Review

## Description
Re-sequence the final datacenter-exit wave (Wave 4) by three weeks to allow the ERP-EMEA shared connectivity re-homing to complete first. The dependency creates a sequencing constraint that cannot be resolved without moving Wave 4.

## Impact Assessment
| Dimension | Impact |
|-----------|--------|
| Schedule | +3 weeks to programme end date |
| Cost | Nil (resources already committed) |
| Scope | No change |
| Risk | Reduces risk of concurrent network changes |

## Recommendation
Approve. The three-week shift avoids concurrent high-risk network changes and aligns with the ERP-EMEA steerco-agreed connectivity window.

## Approver(s)
- [ ] Hiroshi Tanaka (Programme Sponsor)
- [ ] Sofia Almeida (Group CFO — cross-programme dependency sign-off)`,
  owner_id:   owner,
  created_by: owner,
});

// ── Workspace-level: Steering Committee Minutes ───────────────────────────────
await ins({
  workspace_id: W,
  project_id:   null,   // workspace-level
  reference_id: nextRef(),
  folder:       "Minutes",
  title:        "Portfolio Steering Committee Minutes — 2026-06-05",
  doc_type:     "minutes",
  status:       "approved",
  version:      1,
  summary:      "Approved minutes from the June 2026 Portfolio Steering Committee covering all six Meridian Global programmes.",
  body: `# Portfolio Steering Committee — Meeting Minutes

**Date:** 2026-06-05
**Chair:** Sofia Almeida (Group CFO)
**Attendees:** Hiroshi Tanaka, Elena Rossi, programme leads

---

## Agenda Items

### 1. Portfolio RAG Summary
- ERP-EMEA: **Amber** — integrator gate slippage; SLA escalation triggered.
- FIN-MIG: **Red** — GL reconciliation defects; recovery plan presented.
- CLD-APAC: **Green** — ahead of curve; wave 4 dependency watch.
- CDP-CORE: **Amber** — match rate below target; resource clash noted.
- ECM-WEB: **Green** — beta metrics positive; compliance review scheduled.
- IAM-SEC: **Complete** — programme closed.

### 2. Decisions
- **Approved:** FIN-MIG recovery plan including additional QA squad (CR-002).
- **Approved:** ERP-EMEA SIT extension by 2 weeks (CR-001).
- **Escalated to next meeting:** CLD-APAC wave 4 re-sequencing (CR-003) — pending ERP-EMEA schedule confirmation.

### 3. Actions
| Owner | Action | Due |
|-------|--------|-----|
| Elena Rossi | FIN-MIG: resource QA squad onboarded | 2026-06-15 |
| Elena Rossi | ERP-EMEA: integrator formal response received | 2026-06-12 |
| Elena Rossi | CLD-APAC: CR-003 resubmit with updated ERP-EMEA milestone dates | 2026-06-12 |

---

_Minutes approved by: Sofia Almeida. Distributed: 2026-06-06._`,
  owner_id:   owner,
  created_by: owner,
});

await ins({
  workspace_id: W,
  project_id:   null,   // workspace-level
  reference_id: nextRef(),
  folder:       "Minutes",
  title:        "Portfolio Steering Committee Minutes — 2026-05-08",
  doc_type:     "minutes",
  status:       "approved",
  version:      1,
  summary:      "Approved minutes from the May 2026 Portfolio Steering Committee. Baseline freeze for ERP-EMEA approved.",
  body: `# Portfolio Steering Committee — Meeting Minutes

**Date:** 2026-05-08
**Chair:** Sofia Almeida (Group CFO)
**Attendees:** Hiroshi Tanaka, Elena Rossi, programme leads

---

## Agenda Items

### 1. Portfolio Status
All six programmes reported. ERP-EMEA baseline freeze approved to protect the agreed cutover date. CLD-APAC wave 1 and 2 go-live confirmed.

### 2. Decisions
- **Approved:** ERP-EMEA baseline freeze (schedule locked for steerco).
- **Approved:** CLD-APAC wave 3 proceed to go-live.
- **Noted:** CDP-CORE identity-resolution remediation plan.

### 3. Actions
| Owner | Action | Due |
|-------|--------|-----|
| Elena Rossi | ERP-EMEA baseline snapshot submitted to Trust Center | 2026-05-10 |
| Carlos Mendes | CLD-APAC wave 3 go/no-go confirmed | 2026-05-15 |

---

_Minutes approved by: Sofia Almeida. Distributed: 2026-05-09._`,
  owner_id:   owner,
  created_by: owner,
});

// ── Workspace-level: Change Request (in_review) — second one ─────────────────
await ins({
  workspace_id: W,
  project_id:   byCode["FIN-MIG"],
  reference_id: nextRef(),
  folder:       "Change Control",
  title:        "CR-004: Extend FIN-MIG Dress Rehearsal Window by 1 Week",
  doc_type:     "change_request",
  status:       "in_review",
  version:      1,
  summary:      "Change request to extend the FIN-MIG dress rehearsal window by one week to allow the reconciliation QA squad to drive defect rate below the 0.5% threshold before the rehearsal.",
  body: `# Change Request — CR-004

**Project:** FIN-MIG — Finance Data Migration Global
**Requester:** Elena Rossi
**Date:** 2026-06-08
**Status:** In Review

## Description
Extend the dress rehearsal window by one additional week. The reconciliation defect rate currently sits at 2.1% against a 0.5% threshold. The newly onboarded QA squad requires one additional week to drive the rate below threshold before a meaningful rehearsal can be run.

## Impact Assessment
| Dimension | Impact |
|-----------|--------|
| Schedule | +1 week to dress rehearsal; contingency slip plan pre-agreed with CFO |
| Cost | Nil (squad already funded under CR-002) |
| Scope | No change |
| Risk | Materially reduces cutover risk |

## Recommendation
Approve. The risk of running the rehearsal at 2.1% defect rate far outweighs the schedule impact.

## Approver(s)
- [ ] Sofia Almeida (Group CFO)
- [ ] Finance Controller (reconciliation sign-off authority)`,
  owner_id:   owner,
  created_by: owner,
});

console.log(`\n✓ Seed complete — ${docNum} documents inserted into the demo workspace.`);
