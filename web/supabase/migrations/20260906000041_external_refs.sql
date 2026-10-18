-- NoPM · 0041 external_refs — complement seam (R-81).
--
-- NoPM does not replace Jira, Slack or Teams; it is the governed record beside
-- them. Lite and fast. Not ClickUp. This migration gives every core record a
-- seam to the system it complements: a nullable, additive (`source`,
-- `external_ref`, `external_url`) triple on tasks/projects/risks/issues/
-- decisions, so a task can carry "this mirrors JIRA-1234" without NoPM ever
-- syncing, polling, or otherwise depending on that other system.
--
-- source is a short lowercase slug (e.g. 'jira', 'slack', 'teams') — not an
-- enum, so a workspace can name any system of record without a schema change.
-- external_ref is the free-text id/key in that system (e.g. 'PROJ-123',
-- a Slack permalink id). external_url is optional and, when present, must be
-- an http(s) URL — the UI renders it as a clickable chip.
--
-- The partial unique index (workspace_id, coalesce(source, ''), external_ref)
-- where external_ref is not null prevents two records in the same workspace both
-- claiming to mirror the same upstream item under the same source — a light
-- integrity guarantee, not a sync contract. source is coalesced to '' inside
-- the index because Postgres treats NULLs as distinct in unique indexes — without
-- it, two rows with a NULL source and the same external_ref would both be admitted. All three columns are nullable
-- and additive: no existing row or query is affected.

alter table tasks
  add column source text,
  add column external_ref text,
  add column external_url text;

alter table tasks
  add constraint tasks_source_format_chk
    check (source is null or source ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  add constraint tasks_external_url_format_chk
    check (external_url is null or external_url ~* '^https?://');

create unique index tasks_external_ref_uidx
  on tasks(workspace_id, coalesce(source, ''), external_ref)
  where external_ref is not null;

comment on column tasks.source is
  'system of work this record mirrors (e.g. jira, slack, teams); NoPM is the governed record beside it';
comment on column tasks.external_ref is
  'id or key of this record in the source system (e.g. PROJ-123, a Slack permalink id); unique per (workspace, source)';
comment on column tasks.external_url is
  'optional http(s) link to the record in the source system; rendered as a chip, never fetched by NoPM';

alter table projects
  add column source text,
  add column external_ref text,
  add column external_url text;

alter table projects
  add constraint projects_source_format_chk
    check (source is null or source ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  add constraint projects_external_url_format_chk
    check (external_url is null or external_url ~* '^https?://');

create unique index projects_external_ref_uidx
  on projects(workspace_id, coalesce(source, ''), external_ref)
  where external_ref is not null;

comment on column projects.source is
  'system of work this record mirrors (e.g. jira, slack, teams); NoPM is the governed record beside it';
comment on column projects.external_ref is
  'id or key of this record in the source system (e.g. PROJ-123, a Slack permalink id); unique per (workspace, source)';
comment on column projects.external_url is
  'optional http(s) link to the record in the source system; rendered as a chip, never fetched by NoPM';

alter table risks
  add column source text,
  add column external_ref text,
  add column external_url text;

alter table risks
  add constraint risks_source_format_chk
    check (source is null or source ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  add constraint risks_external_url_format_chk
    check (external_url is null or external_url ~* '^https?://');

create unique index risks_external_ref_uidx
  on risks(workspace_id, coalesce(source, ''), external_ref)
  where external_ref is not null;

comment on column risks.source is
  'system of work this record mirrors (e.g. jira, slack, teams); NoPM is the governed record beside it';
comment on column risks.external_ref is
  'id or key of this record in the source system (e.g. PROJ-123, a Slack permalink id); unique per (workspace, source)';
comment on column risks.external_url is
  'optional http(s) link to the record in the source system; rendered as a chip, never fetched by NoPM';

alter table issues
  add column source text,
  add column external_ref text,
  add column external_url text;

alter table issues
  add constraint issues_source_format_chk
    check (source is null or source ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  add constraint issues_external_url_format_chk
    check (external_url is null or external_url ~* '^https?://');

create unique index issues_external_ref_uidx
  on issues(workspace_id, coalesce(source, ''), external_ref)
  where external_ref is not null;

comment on column issues.source is
  'system of work this record mirrors (e.g. jira, slack, teams); NoPM is the governed record beside it';
comment on column issues.external_ref is
  'id or key of this record in the source system (e.g. PROJ-123, a Slack permalink id); unique per (workspace, source)';
comment on column issues.external_url is
  'optional http(s) link to the record in the source system; rendered as a chip, never fetched by NoPM';

alter table decisions
  add column source text,
  add column external_ref text,
  add column external_url text;

alter table decisions
  add constraint decisions_source_format_chk
    check (source is null or source ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  add constraint decisions_external_url_format_chk
    check (external_url is null or external_url ~* '^https?://');

create unique index decisions_external_ref_uidx
  on decisions(workspace_id, coalesce(source, ''), external_ref)
  where external_ref is not null;

comment on column decisions.source is
  'system of work this record mirrors (e.g. jira, slack, teams); NoPM is the governed record beside it';
comment on column decisions.external_ref is
  'id or key of this record in the source system (e.g. PROJ-123, a Slack permalink id); unique per (workspace, source)';
comment on column decisions.external_url is
  'optional http(s) link to the record in the source system; rendered as a chip, never fetched by NoPM';
