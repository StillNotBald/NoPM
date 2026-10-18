-- NoPM · 0091 risks.impact_areas (audit gap K2, CR-2026-10-18-01).
--
-- A risk can touch more than one area (schedule AND cost). impact_areas is the
-- source of truth; the single impact_area column is kept in step with it
-- (first element) so older readers and exports keep working. Additive, with a
-- backfill from the old column.

alter table risks
  add column if not exists impact_areas risk_impact_area[] not null default '{}';

-- Backfill BEFORE the sync trigger exists: one-element array from the old column.
-- trg_risks_updated is paused so no risk's updated_at moves (staleness nudges and
-- open edit forms' expected_updated_at depend on it), as 0088 and 0089 do.
alter table risks disable trigger trg_risks_updated;
update risks
   set impact_areas = array[impact_area]
 where impact_area is not null
   and cardinality(impact_areas) = 0;
alter table risks enable trigger trg_risks_updated;

create or replace function risks_sync_impact_area() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if cardinality(new.impact_areas) > 0 then
      -- the array wins when both are written
      new.impact_area := new.impact_areas[1];
    elsif new.impact_area is not null then
      new.impact_areas := array[new.impact_area];
    end if;
  else
    if new.impact_areas is distinct from old.impact_areas then
      new.impact_area := case when cardinality(new.impact_areas) > 0 then new.impact_areas[1] else null end;
    elsif new.impact_area is distinct from old.impact_area then
      new.impact_areas := case when new.impact_area is null then '{}'::risk_impact_area[] else array[new.impact_area] end;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_risks_sync_impact_area on risks;
create trigger trg_risks_sync_impact_area
  before insert or update on risks
  for each row execute function risks_sync_impact_area();

create index if not exists idx_risks_impact_areas on risks using gin (impact_areas);

comment on column risks.impact_areas is
  'Areas this risk touches (source of truth). risks.impact_area mirrors the first element for backward compatibility.';
