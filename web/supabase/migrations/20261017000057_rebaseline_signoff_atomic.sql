-- NoPM · 0057 (2026-10-17) — rebaseline apply keeps the TRUE previous project
-- baseline across a retry.
--
-- File name note: this slot was reserved as "rebaseline_signoff_atomic". The
-- sign-off race itself is fixed in the route (a vote is withdrawn when its
-- status write loses; no SQL needed), so the one database change this wave
-- needs is the apply-side column below.
--
-- WHY. POST /api/rebaselines/:id/apply reads the project's baseline, runs the
-- snapshot RPC (which moves it), flips approved -> applied and then writes the
-- audit row. A transient failure after the RPC leaves the rebaseline `approved`;
-- the retry used to read the already-moved baseline as its "before", so the
-- audit recorded before == after and the real previous baseline was lost.
--
-- WHAT. rebaselines.baseline_before jsonb ({ start, target }) holds the project
-- baseline as it was before the first apply attempt moved it. The route writes
-- it BEFORE the RPC and reuses it on retry. It is WRITE-ONCE: a BEFORE UPDATE
-- trigger keeps the first non-null value, so two racing applies cannot replace
-- it with an already-moved baseline.
--
-- BACKWARD COMPATIBLE. Additive nullable column; the route falls back to the
-- in-memory read when the column does not exist yet.
-- ROLLBACK. drop trigger trg_rebaseline_baseline_before_once on rebaselines;
--           drop function nopm_rebaseline_baseline_before_once();
--           alter table rebaselines drop column baseline_before;

alter table rebaselines
  add column if not exists baseline_before jsonb;

comment on column rebaselines.baseline_before is
  'the project baseline ({start,target}) as it was BEFORE the first apply attempt moved it; write-once, so an apply retry still records the real previous baseline';

create or replace function nopm_rebaseline_baseline_before_once()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.baseline_before is not null then
    new.baseline_before := old.baseline_before;
  end if;
  return new;
end;
$$;

revoke execute on function nopm_rebaseline_baseline_before_once() from public, anon, authenticated;
grant  execute on function nopm_rebaseline_baseline_before_once() to service_role;

drop trigger if exists trg_rebaseline_baseline_before_once on rebaselines;
create trigger trg_rebaseline_baseline_before_once
  before update on rebaselines
  for each row
  when (old.baseline_before is not null and new.baseline_before is distinct from old.baseline_before)
  execute function nopm_rebaseline_baseline_before_once();
