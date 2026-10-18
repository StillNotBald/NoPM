-- Backfill human-readable reference IDs for rows that predate the reference_id
-- column (seeded directly, bypassing the API that assigns them). Per workspace,
-- ordered by creation. New records keep getting the next id via lib/ref-id.ts.
update risks r set reference_id = sub.ref
from (
  select id, 'R-' || lpad(row_number() over (partition by workspace_id order by created_at, id)::text, 3, '0') as ref
  from risks where reference_id is null
) sub
where r.id = sub.id and r.reference_id is null;

update issues i set reference_id = sub.ref
from (
  select id, 'ISS-' || lpad(row_number() over (partition by workspace_id order by created_at, id)::text, 3, '0') as ref
  from issues where reference_id is null
) sub
where i.id = sub.id and i.reference_id is null;

update clashes c set reference_id = sub.ref
from (
  select id, 'CL-' || lpad(row_number() over (partition by workspace_id order by created_at, id)::text, 3, '0') as ref
  from clashes where reference_id is null
) sub
where c.id = sub.id and c.reference_id is null;
