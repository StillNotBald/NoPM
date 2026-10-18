-- NoPM · 0085 risk / issue category taxonomy + sign-off column names.
--
-- 1. risk_category / issue_category move to an 8-value set each, based on the
--    public PMBOK risk breakdown structure (technical, external, organisational,
--    project management) with ISO 31000-style groupings. Existing rows are mapped
--    to the closest new value. Fresh installs already get the new set from 0008,
--    so every step here is a guarded no-op there.
-- 2. rebaseline_signoffs: legacy sign-off column names become proxy_for and cast_by.
--    No SQL function references these columns, so no function is redefined.

-- ── 1a. risk_category ───────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_type where typname = 'risk_category')
     and not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                     where t.typname = 'risk_category' and e.enumlabel = 'organisational') then
    create type risk_category_v2 as enum (
      'technical', 'schedule', 'cost', 'resourcing',
      'scope_requirements', 'supplier_external', 'regulatory_legal', 'organisational'
    );
    alter table risks
      alter column risk_category type risk_category_v2
      using (case risk_category::text
        when 'timeline_schedule'          then 'schedule'
        when 'dependencies_third_party'   then 'supplier_external'
        when 'operational_continuity'     then 'organisational'
        when 'technology_infrastructure'  then 'technical'
        when 'financial_capex'            then 'cost'
        when 'resource_management'        then 'resourcing'
        when 'scope_management'           then 'scope_requirements'
        when 'data_information'           then 'technical'
        when 'compliance_regulatory'      then 'regulatory_legal'
        when 'change_stakeholder'         then 'organisational'
      end)::risk_category_v2;
    drop type risk_category;
    alter type risk_category_v2 rename to risk_category;
  end if;
end $$;

-- ── 1b. issue_category ──────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_type where typname = 'issue_category')
     and not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                     where t.typname = 'issue_category' and e.enumlabel = 'external_event') then
    create type issue_category_v2 as enum (
      'technical_fault', 'resourcing', 'schedule_delay', 'cost_overrun',
      'scope_change', 'organisational', 'supplier', 'external_event'
    );
    alter table issues
      alter column issue_category type issue_category_v2
      using (case issue_category::text
        when 'technical_defect'         then 'technical_fault'
        when 'resource_unavailability'  then 'resourcing'
        when 'dependency_delay'         then 'schedule_delay'
        when 'budget_funding'           then 'cost_overrun'
        when 'scope_creep'              then 'scope_change'
        when 'stakeholder_conflict'     then 'organisational'
        when 'operational_bottleneck'   then 'organisational'
        when 'data_quality'             then 'technical_fault'
        when 'third_party_vendor'       then 'supplier'
        when 'environmental_external'   then 'external_event'
      end)::issue_category_v2;
    drop type issue_category;
    alter type issue_category_v2 rename to issue_category;
  end if;
end $$;

comment on column risks.risk_category  is 'Risk category: 8 values loosely following the PMBOK risk breakdown structure.';
comment on column issues.issue_category is 'Issue category: 8 values, same public basis as risk_category.';

-- ── 2. sign-off column renames ──────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = current_schema() and table_name = 'rebaseline_signoffs'
               and column_name = 'voted_on_behalf') then
    alter table rebaseline_signoffs rename column voted_on_behalf to proxy_for;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = current_schema() and table_name = 'rebaseline_signoffs'
               and column_name = 'voted_by') then
    alter table rebaseline_signoffs rename column voted_by to cast_by;
  end if;
  if exists (select 1 from pg_constraint
             where conname = 'rebaseline_signoffs_voted_by_fkey'
               and conrelid = 'rebaseline_signoffs'::regclass) then
    alter table rebaseline_signoffs
      rename constraint rebaseline_signoffs_voted_by_fkey to rebaseline_signoffs_cast_by_fkey;
  end if;
end $$;
