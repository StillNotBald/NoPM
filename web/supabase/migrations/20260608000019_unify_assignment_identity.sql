-- NoPM · 0019 unify task assignment with the resource/capacity/cost layer.
--
-- Before: tasks.assignee_id referenced profiles(id) (login users), while the
-- whole UI (task form picker, activity table, board) treats the assignee as a
-- resource_member (the costed, capacity-bearing person). That split meant task
-- assignment never connected to capacity (allocations) or cost (cost_rate/EVM).
--
-- After: tasks.assignee_id references resource_members(id) — the canonical
-- "person who does the work". A resource_member optionally links to a login via
-- resource_members.profile_id, so "My Tasks"/"My Work" bridge member -> profile.
-- One identity across assignment, capacity, and cost.

-- Drop the old profiles FK.
alter table tasks drop constraint if exists tasks_assignee_id_fkey;

-- Existing assignee_id values are profile ids under the old model and would
-- violate the new FK — clear them; assignments are re-seeded against members.
update tasks set assignee_id = null where assignee_id is not null;

-- Re-point the FK at resource_members.
alter table tasks
  add constraint tasks_assignee_id_fkey
  foreign key (assignee_id) references resource_members(id) on delete set null;

comment on column tasks.assignee_id is
  'Assigned resource_member (costed, capacity-bearing person). Login users bridge via resource_members.profile_id.';
