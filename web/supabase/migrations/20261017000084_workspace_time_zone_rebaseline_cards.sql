-- 0084 (common-pattern answers, worker P6): workspace time zone + rebaseline
-- sign-off cards.
--
--  * workspaces.time_zone (Q-ACC-18 / Q-WRK-23): an IANA zone name, default
--    Malaysia. Used for the weekly digest weekday + "today" defaults. Additive:
--    every existing workspace gets the default.
--  * The Lark hub's approval_kind CHECKs widen to allow 'rebaseline_signoff'
--    (Q-GOV-19 / Q-ACC-17). Widening only: every existing value stays legal.
--    NOT VALID then VALIDATE so the swap is instant and then checked.

alter table workspaces
  add column if not exists time_zone text not null default 'Asia/Kuala_Lumpur';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workspaces_time_zone_len_check'
  ) then
    alter table workspaces
      add constraint workspaces_time_zone_len_check
      check (char_length(time_zone) between 1 and 64) not valid;
    alter table workspaces validate constraint workspaces_time_zone_len_check;
  end if;
end $$;

alter table integration_deliveries drop constraint if exists integration_deliveries_approval_kind_check;
alter table integration_deliveries
  add constraint integration_deliveries_approval_kind_check
  check (approval_kind is null or approval_kind in
    ('task_deletion', 'project_deletion', 'change_request', 'timesheet', 'rebaseline_signoff')) not valid;
alter table integration_deliveries validate constraint integration_deliveries_approval_kind_check;

alter table action_tokens drop constraint if exists action_tokens_approval_kind_check;
alter table action_tokens
  add constraint action_tokens_approval_kind_check
  check (approval_kind in
    ('task_deletion', 'project_deletion', 'change_request', 'timesheet', 'rebaseline_signoff')) not valid;
alter table action_tokens validate constraint action_tokens_approval_kind_check;

-- Q-ACC-10: a demo-key turn whose provider call failed does not count against
-- the shared demo allowance. Gives one unit back to the per-user counter
-- (never below zero). Service role only, like nopm_demo_rate_check.
create or replace function nopm_demo_rate_refund(p_user uuid)
  returns void
  language plpgsql
  set search_path = public
as $$
begin
  update assistant_demo_usage set count = greatest(count - 1, 0) where user_id = p_user;
end;
$$;
revoke execute on function nopm_demo_rate_refund(uuid) from public, anon, authenticated;
grant execute on function nopm_demo_rate_refund(uuid) to service_role;
