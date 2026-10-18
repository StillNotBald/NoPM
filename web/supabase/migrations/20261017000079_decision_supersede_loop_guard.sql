-- NoPM · 0079 decision supersede loop guard (Q-GOV-15).
-- A decision may replace an earlier one; the chain must never loop back on
-- itself. The API refuses loops with a clear 422; this trigger is the backstop
-- for any other writer. Additive; touches no existing row.

create or replace function nopm_decisions_no_supersede_loop() returns trigger
language plpgsql as $$
declare
  cur uuid := new.supersedes;
  hops int := 0;
begin
  if cur is null then
    return new;
  end if;
  if cur = new.id then
    raise exception 'a decision cannot supersede itself' using errcode = '23514';
  end if;
  while cur is not null and hops < 1000 loop
    if cur = new.id then
      raise exception 'supersede chain would loop' using errcode = '23514';
    end if;
    select d.supersedes into cur from decisions d where d.id = cur;
    hops := hops + 1;
  end loop;
  return new;
end $$;

drop trigger if exists trg_decisions_no_supersede_loop on decisions;
create trigger trg_decisions_no_supersede_loop
  before insert or update of supersedes on decisions
  for each row execute function nopm_decisions_no_supersede_loop();
