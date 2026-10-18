-- NoPM · 0008 content enrichment — additive P0 fields that bring PMBOK-style
-- richness (charter, baselines, risk scoring, RAID parity) onto existing tables.
--
-- ADDITIVE ONLY: every column is nullable (or carries a safe default); no existing
-- column is altered or dropped. New enum types back CHECK-constrained columns.
-- Derived metrics (risk_score, exposure band, EVM strip) are intentionally NOT
-- stored — they are computed read-side, so there is no new write path to audit.

-- ── New enum types ──────────────────────────────────────────────────────────
create type project_phase      as enum ('initiation', 'planning', 'execution', 'monitoring', 'closing');
create type risk_response       as enum ('avoid', 'transfer', 'mitigate', 'accept');
create type risk_impact_area    as enum ('schedule', 'cost', 'scope', 'quality', 'reputation', 'compliance');
create type risk_category       as enum (
  'technical',
  'schedule',
  'cost',
  'resourcing',
  'scope_requirements',
  'supplier_external',
  'regulatory_legal',
  'organisational'
);
create type issue_category      as enum (
  'technical_fault',
  'resourcing',
  'schedule_delay',
  'cost_overrun',
  'scope_change',
  'organisational',
  'supplier',
  'external_event'
);

-- ── projects: PMBOK charter block + baseline pair + phase ────────────────────
alter table projects
  add column business_case        text,
  add column objective            text,
  add column scope_summary        text,
  add column sponsor              text,
  add column project_manager      text,
  add column phase                project_phase not null default 'planning',
  add column health_commentary    text,
  add column baseline_start_date  date,
  add column baseline_target_date date;
comment on column projects.business_case        is 'PMBOK charter: business case / justification.';
comment on column projects.objective            is 'PMBOK charter: project purpose / objective.';
comment on column projects.scope_summary        is 'PMBOK charter: high-level scope.';
comment on column projects.sponsor              is 'PMBOK charter: named project sponsor.';
comment on column projects.project_manager      is 'PMBOK charter: named project manager.';
comment on column projects.phase                is 'PMBOK process group the project is currently in.';
comment on column projects.health_commentary    is 'RAG narrative — one-line "why is it amber?".';
comment on column projects.baseline_start_date  is 'PMBOK baseline start; pairs with start_date for schedule variance.';
comment on column projects.baseline_target_date is 'PMBOK baseline finish; source for rebaseline diff.';

-- ── milestones: description, deliverable, real start + baseline pair ─────────
alter table milestones
  add column description          text,
  add column deliverable          text,
  add column start_date           date,
  add column baseline_target_date date,
  add column actual_date          date;
comment on column milestones.description          is 'Milestone narrative.';
comment on column milestones.deliverable          is 'PMBOK WBS deliverable / acceptance output.';
comment on column milestones.start_date           is 'Milestone start; needed for a real Gantt bar.';
comment on column milestones.baseline_target_date is 'PMBOK baseline finish; feeds rebaseline diff.';
comment on column milestones.actual_date          is 'Actual achieved date.';

-- ── tasks: agile / Jira-Asana-ClickUp parity metadata ───────────────────────
alter table tasks
  add column acceptance_criteria text,
  add column estimate_hours      numeric(8,2) check (estimate_hours is null or estimate_hours >= 0),
  add column story_points        numeric(5,1) check (story_points   is null or story_points   >= 0),
  add column labels              text[] not null default '{}',
  add column blocked_by          uuid references tasks(id) on delete set null;
comment on column tasks.acceptance_criteria is 'Agile definition-of-done; gives the task drawer body content.';
comment on column tasks.estimate_hours      is 'ClickUp/Jira time estimate (hours); ties to capacity.';
comment on column tasks.story_points        is 'Jira/ClickUp story points.';
comment on column tasks.labels              is 'Jira labels / Asana tags / ClickUp tags.';
comment on column tasks.blocked_by          is 'Blocking task (Jira/ClickUp blocker; Asana dependency).';

-- ── risks: PMBOK risk-register fields (probability/impact ints, strategy, ──
--    impact area, trigger, residual). risk_score / exposure stay computed.
alter table risks
  add column probability_pct  int  check (probability_pct is null or probability_pct between 0 and 100),
  add column impact_score     int  check (impact_score    is null or impact_score    between 1 and 5),
  add column response_strategy risk_response not null default 'mitigate',
  add column risk_category    risk_category,
  add column impact_area      risk_impact_area,
  add column trigger          text,
  add column residual_risk    text;
comment on column risks.probability_pct  is 'PMBOK quantitative probability of occurrence (0-100).';
comment on column risks.impact_score     is 'PMBOK impact on a 1-5 scale; pairs with likelihood for the 5x5 matrix.';
comment on column risks.response_strategy is 'PMBOK four threat responses (orthogonal to status).';
comment on column risks.risk_category    is 'Risk category: 8 values loosely following the PMBOK risk breakdown structure.';
comment on column risks.impact_area      is 'PMBOK impact category the risk threatens.';
comment on column risks.trigger          is 'PMBOK risk trigger / early-warning indicator.';
comment on column risks.residual_risk    is 'PMBOK residual risk remaining after the chosen response.';

-- ── issues: RAID-log parity with the risk register ──────────────────────────
alter table issues
  add column severity       severity_level not null default 'medium',
  add column issue_category issue_category,
  add column impact         text,
  add column resolution_eta date,
  add column resolved_at    date;
comment on column issues.severity       is 'PMBOK issue impact severity; parity with the risk register.';
comment on column issues.issue_category is 'Issue category: 8 values, same public basis as risk_category.';
comment on column issues.impact         is 'PMBOK issue-log "impact" narrative.';
comment on column issues.resolution_eta is 'PMBOK target resolution date.';
comment on column issues.resolved_at    is 'PMBOK issue lifecycle: date the issue was resolved/closed.';

-- ── project_budget: PMBOK actual cost + reserves (EAC/EVM stay computed) ─────
alter table project_budget
  add column actual_amount        numeric(14,2) not null default 0 check (actual_amount        >= 0),
  add column contingency_reserve  numeric(14,2) not null default 0 check (contingency_reserve  >= 0),
  add column management_reserve   numeric(14,2) not null default 0 check (management_reserve    >= 0);
comment on column project_budget.actual_amount       is 'PMBOK Actual Cost (AC); seedable, also derivable from expenses + time-entry cost.';
comment on column project_budget.contingency_reserve is 'PMBOK contingency reserve (known-unknowns buffer).';
comment on column project_budget.management_reserve  is 'PMBOK management reserve (unknown-unknowns buffer).';
