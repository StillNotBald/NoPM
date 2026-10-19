-- NoPM · 0110 (2026-10-18) — the four unattended / trigger-driven writers audit in ONE transaction (M1 close-out, W5-C, R-165).
--
-- WHY. Four library paths still wrote first and audited second (rows 21 to 24 of the wave 5 atomicity list):
-- clash auto-resolve, the overspend level marker, the nightly snapshot run and the weekly report. A failure
-- between the write and its audit row left a change the trail never saw (or, for the overspend marker and the
-- weekly claim, compensating code that could itself fail). Each RPC below does the write and calls the shared
-- helper nopm_audit_insert (0107) in the same transaction, so both happen or neither does.
--
-- WHAT. Four functions. Clash create and clash update-existing need no function here: they go through the
-- generic nopm_mutate_audited (0103) on the allowlisted table `clashes`, with the caller as the actor.
--   nopm_clash_auto_resolve(workspace, clash id, audit)       resolve ONE live clash; the status guard is in SQL,
--                                                             so a lost race returns NULL and writes NO audit row.
--   nopm_overspend_cross(workspace, project, previous, next,  compare-and-set of project_budget.overspend_level on
--                        audit, after)                        the previous value, plus the budget.overspend row.
--                                                             Returns false (nothing written) when the marker moved.
--   nopm_snapshot_run(workspace, taken_at, rows, audit)       insert the run's project_snapshots rows (on conflict
--                                                             do nothing) and write ONE snapshot.taken row for the
--                                                             workspace. Returns {projects, taken, already_taken}.
--   nopm_weekly_report_store(workspace, week, snapshot, ...)  claim the scheduled recipients (nudge_log), store the
--                                                             report (weekly_reports) and write the
--                                                             report.weekly.generated row. Idempotent per workspace
--                                                             week: a replayed scheduled run returns already_sent
--                                                             and writes nothing. A manual run makes no claim.
-- The audit rows keep the action names and before / after shapes of today's code. Clash resolve is audited as the
-- caller; the snapshot and weekly report rows as the system actor (nil actor id, 'system:' label, no principal);
-- the overspend row as the caller. The caller builds p_audit with buildRpcAudit() (web/src/lib/audit).
--
-- SAFETY. security definer, search_path pinned to public, executable by service_role only. Every statement is
-- filtered by p_workspace_id; recipients and projects of another workspace are ignored. p_audit is TRUSTED input
-- (service role callers only), like 0103 and 0107. Error codes come from nopm_audit_insert (P0005, P0057 to P0059); this file adds P0070 INVALID_ROWS and P0071 INVALID_TRIGGER.
--
-- ORDER OF APPLY. After 0107, before deploying the build that calls these. The old build never calls them, so the
-- migration is safe ahead of the deploy. Additive: four create-or-replace functions, no table is touched, so it is
-- safe on live rows. Safe to re-run.
-- ROLLBACK. drop function nopm_clash_auto_resolve(uuid, uuid, jsonb);
--           drop function nopm_overspend_cross(uuid, uuid, text, text, jsonb, jsonb);
--           drop function nopm_snapshot_run(uuid, date, jsonb, jsonb);
--           drop function nopm_weekly_report_store(uuid, date, jsonb, text, timestamptz, uuid[], date, text, jsonb);

-- 1. Clash auto-resolve ----------------------------------------------------------------------------------------
create or replace function nopm_clash_auto_resolve(
  p_workspace_id uuid,
  p_clash_id     uuid,
  p_audit        jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  -- Lock the live row first: of two racing resolvers the second sees status 'resolved', finds nothing,
  -- returns NULL and writes no second audit row.
  select to_jsonb(c) into v_before
    from clashes c
   where c.id = p_clash_id
     and c.workspace_id = p_workspace_id
     and c.status in ('open', 'investigating')
     for update;
  if v_before is null then
    return null;
  end if;

  update clashes
     set status = 'resolved'
   where id = p_clash_id
     and workspace_id = p_workspace_id
     and status in ('open', 'investigating');

  select to_jsonb(c) into v_after from clashes c where c.id = p_clash_id and c.workspace_id = p_workspace_id;

  perform nopm_audit_insert(p_workspace_id, p_audit, p_clash_id, v_before, v_after);
  return jsonb_build_object('before', v_before, 'after', v_after);
end;
$$;

revoke execute on function nopm_clash_auto_resolve(uuid, uuid, jsonb) from public, anon, authenticated;
grant  execute on function nopm_clash_auto_resolve(uuid, uuid, jsonb) to service_role;

comment on function nopm_clash_auto_resolve(uuid, uuid, jsonb) is
  'Wave 5 R-165: resolve one live clash and write its clash.auto_resolve audit row in one transaction. Returns NULL (and writes nothing) when the clash is no longer live.';

-- 2. Overspend level crossing ------------------------------------------------------------------------------------
create or replace function nopm_overspend_cross(
  p_workspace_id uuid,
  p_project_id   uuid,
  p_previous     text,
  p_next         text,
  p_audit        jsonb,
  p_after        jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if p_previous is null or p_next is null or p_previous = p_next then
    return false;
  end if;

  -- Compare-and-set on the NON-null previous level: two concurrent expenses cannot both claim the crossing.
  update project_budget
     set overspend_level = p_next
   where project_id = p_project_id
     and workspace_id = p_workspace_id
     and overspend_level = p_previous;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;

  -- If this raises, the marker change above rolls back with it: no compensating write is needed.
  perform nopm_audit_insert(p_workspace_id, p_audit, p_project_id, jsonb_build_object('level', p_previous), p_after);
  return true;
end;
$$;

revoke execute on function nopm_overspend_cross(uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function nopm_overspend_cross(uuid, uuid, text, text, jsonb, jsonb) to service_role;

comment on function nopm_overspend_cross(uuid, uuid, text, text, jsonb, jsonb) is
  'Wave 5 R-165: compare-and-set of project_budget.overspend_level plus the budget.overspend audit row in one transaction. Returns false and writes nothing when the marker is not at the previous level.';

-- 3. Nightly snapshot run ----------------------------------------------------------------------------------------
create or replace function nopm_snapshot_run(
  p_workspace_id uuid,
  p_taken_at     date,
  p_rows         jsonb,
  p_audit        jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int;
  v_taken int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'INVALID_ROWS: p_rows must be a json array' using errcode = 'P0070';
  end if;
  v_total := jsonb_array_length(p_rows);

  -- Same idempotence as the old upsert with ignoreDuplicates: a second run on the same day inserts nothing.
  -- Only projects of THIS workspace are accepted; the workspace and the day come from the parameters.
  with src as (
    select r.*
      from jsonb_to_recordset(p_rows) as r(
             project_id uuid, spi numeric, cpi numeric, eac numeric, planned_end date, forecast_end date,
             slip_days int, completion_pct numeric, open_risks_high int, rag_declared text, rag_suggested text)
      join projects p on p.id = r.project_id and p.workspace_id = p_workspace_id
  ), ins as (
    insert into project_snapshots (workspace_id, project_id, taken_at, spi, cpi, eac, planned_end, forecast_end,
                                   slip_days, completion_pct, open_risks_high, rag_declared, rag_suggested)
    select p_workspace_id, s.project_id, p_taken_at, s.spi, s.cpi, s.eac, s.planned_end, s.forecast_end,
           s.slip_days, s.completion_pct, coalesce(s.open_risks_high, 0), s.rag_declared, s.rag_suggested
      from src s
    on conflict (project_id, taken_at) do nothing
    returning 1
  )
  select count(*)::int into v_taken from ins;

  -- ONE row per workspace per run (not one per project), in the same transaction as the snapshots.
  perform nopm_audit_insert(
    p_workspace_id, p_audit, p_workspace_id, null,
    jsonb_build_object('taken_at', p_taken_at, 'projects', v_total, 'taken', v_taken, 'already_taken', v_total - v_taken));

  return jsonb_build_object('projects', v_total, 'taken', v_taken, 'already_taken', v_total - v_taken);
end;
$$;

revoke execute on function nopm_snapshot_run(uuid, date, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function nopm_snapshot_run(uuid, date, jsonb, jsonb) to service_role;

comment on function nopm_snapshot_run(uuid, date, jsonb, jsonb) is
  'Wave 5 R-165: insert one workspace''s nightly project_snapshots rows (on conflict do nothing) and write the single snapshot.taken audit row in one transaction.';

-- 4. Weekly report: claim, store, audit ----------------------------------------------------------------------------
create or replace function nopm_weekly_report_store(
  p_workspace_id  uuid,
  p_week_start    date,
  p_snapshot      jsonb,
  p_generated_by  text,
  p_generated_at  timestamptz,
  p_recipients    uuid[],
  p_sent_on       date,
  p_trigger       text,
  p_audit         jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipients uuid[];
begin
  if p_trigger is null or p_trigger not in ('scheduled', 'manual') then
    raise exception 'INVALID_TRIGGER: %', coalesce(p_trigger, 'null') using errcode = 'P0071';
  end if;

  if p_trigger = 'scheduled' then
    -- Claim the recipients that have no weekly_report ledger row this ISO week. The unique index
    -- nudge_log_once_per_day arbitrates a race: the loser's insert is skipped, never raised.
    with want as (
      select distinct u.rid
        from unnest(coalesce(p_recipients, '{}'::uuid[])) as u(rid)
        join profiles pr on pr.id = u.rid and pr.workspace_id = p_workspace_id
       where not exists (
         select 1 from nudge_log n
          where n.workspace_id = p_workspace_id
            and n.kind = 'weekly_report'
            and n.target_id = p_workspace_id
            and n.recipient_id = u.rid
            and n.sent_on >= p_week_start)
    ), ins as (
      insert into nudge_log (workspace_id, target_type, target_id, kind, recipient_id, sent_on)
      select p_workspace_id, 'workspace', p_workspace_id, 'weekly_report', w.rid, p_sent_on
        from want w
      on conflict do nothing
      returning recipient_id
    )
    select coalesce(array_agg(recipient_id), '{}'::uuid[]) into v_recipients from ins;

    -- Nothing claimed: this week is already done (or a racing tick won). Write nothing at all.
    if coalesce(array_length(v_recipients, 1), 0) = 0 then
      return jsonb_build_object('status', 'already_sent', 'recipients', '[]'::jsonb);
    end if;
  else
    -- A manual run takes no claim: it refreshes the report and notifies, without using the scheduled slot.
    select coalesce(array_agg(distinct pr.id), '{}'::uuid[]) into v_recipients
      from profiles pr
     where pr.workspace_id = p_workspace_id
       and pr.id = any (coalesce(p_recipients, '{}'::uuid[]));
  end if;

  insert into weekly_reports (workspace_id, week_start, data, generated_at, generated_by)
  values (p_workspace_id, p_week_start, p_snapshot, p_generated_at, p_generated_by)
  on conflict (workspace_id, week_start)
  do update set data = excluded.data, generated_at = excluded.generated_at, generated_by = excluded.generated_by;

  perform nopm_audit_insert(
    p_workspace_id, p_audit, p_workspace_id, null,
    jsonb_build_object('week_start', p_week_start, 'trigger', p_trigger,
                       'recipients', coalesce(array_length(v_recipients, 1), 0)));

  return jsonb_build_object('status', 'stored', 'recipients', to_jsonb(v_recipients));
end;
$$;

revoke execute on function nopm_weekly_report_store(uuid, date, jsonb, text, timestamptz, uuid[], date, text, jsonb) from public, anon, authenticated;
grant  execute on function nopm_weekly_report_store(uuid, date, jsonb, text, timestamptz, uuid[], date, text, jsonb) to service_role;

comment on function nopm_weekly_report_store(uuid, date, jsonb, text, timestamptz, uuid[], date, text, jsonb) is
  'Wave 5 R-165: claim the scheduled recipients, store the weekly report and write its audit row in one transaction. A replayed scheduled run returns already_sent and writes nothing; a manual run makes no claim.';
