-- NoPM · 0022 — four-eyes backstop for rebaselines (Control-Tower / R-04).
--
-- The signoff + apply routes now require a dedicated `rebaseline:approve` scope
-- (deliberately EXCLUDED from the assistant's ephemeral token, so the AI can
-- *raise* a rebaseline but never approve/apply it) and reject a user signing off
-- a rebaseline they requested. This trigger is the DB-level backstop: any
-- rebaseline_signoffs row whose approver equals the parent rebaseline's
-- requester is rejected, so the four-eyes invariant cannot be bypassed even if a
-- future code path forgets the API guard.

create or replace function nopm_rebaseline_no_self_signoff()
  returns trigger
  language plpgsql
  set search_path = public
as $$
declare
  req uuid;
begin
  select requested_by into req from rebaselines where id = new.rebaseline_id;
  if req is not null and new.approver_id = req then
    raise exception 'SELF_SIGNOFF: a rebaseline requester cannot sign off their own rebaseline'
      using errcode = 'P0003';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_rebaseline_no_self_signoff on rebaseline_signoffs;
create trigger trg_rebaseline_no_self_signoff
  before insert or update on rebaseline_signoffs
  for each row execute function nopm_rebaseline_no_self_signoff();
