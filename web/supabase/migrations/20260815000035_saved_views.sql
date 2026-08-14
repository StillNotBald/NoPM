-- NoPM · 0035 saved_views — persisted register views (filters+sort+columns+
-- groupBy) a user can reopen in one click and optionally share with the
-- workspace (L-05/06/07/41).
--
-- Identity model: owner_id -> profiles(id), the LOGIN identity, not
-- resource_members(id) — a saved view is UI/working-state, not a costed
-- entity, so it deliberately does NOT follow the programs.owner_id
-- (resource_members) precedent from migration 0034. owner_id is NULLABLE
-- because token/agent actors (Bearer PAT callers) have no profiles row to
-- own a PRIVATE view with; a token-authored view is always created with
-- scope='shared' (enforced in POST /api/saved-views, not just here) so it
-- never needs a private owner. The CHECK below is the DB backstop for that
-- same rule: a personal-scoped row can never have a null owner.
--
-- register is intentionally free text (format-checked, not enum-checked):
-- the task spec's own wording is "target register key e.g.
-- tasks|risks|issues|clashes" — an "e.g.", not an exhaustive list — so a
-- fixed enum here would force a migration every time a new register grows
-- saved views. The API layer is the place that decides which register
-- values it currently recognises.
--
-- AUDIT boundary (ADR 0009): saved_views are WORKSPACE data, not personal
-- display prefs — unlike user_preferences (L-39, amended into ADR 0009
-- separately), every create/update/delete/share/protect mutation here is
-- audited via writeAudit, no exception.
create table saved_views (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  owner_id     uuid references profiles(id) on delete cascade,
  register     text not null check (register ~ '^[a-z][a-z_]*$'),
  name         text not null check (char_length(trim(name)) > 0),
  config       jsonb not null default '{}'::jsonb, -- { filters, sort, columns, groupBy } — see web/src/lib/views/view-config.ts
  scope        text not null default 'personal' check (scope in ('personal', 'shared')),
  protected    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint saved_views_personal_needs_owner
    check (scope = 'shared' or owner_id is not null)
);

create index on saved_views(workspace_id);
create index on saved_views(owner_id, register);

create trigger trg_saved_views_updated before update on saved_views
  for each row execute function nopm_set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Mirrors the house pattern (workspace-scoped, viewers read-only) PLUS an
-- owner clause — the DB-level backstop for L-41's "personal filters stay
-- private": a session user can never SELECT another identity's personal
-- (scope='personal') row, RLS-enforced, not just API-filtered. Token/agent
-- callers use the admin client and bypass RLS entirely, so the API layer
-- applies the identical owner-or-shared predicate explicitly (see
-- src/app/api/saved-views/_visibility.ts) — workspace-isolation.test.ts's
-- static scoping-token check covers that.
--
-- Deliberately FOUR separate command-scoped policies rather than one
-- `for all`: Postgres only re-checks a row's SELECT policy for a plain
-- SELECT — an UPDATE/DELETE's own USING clause (not the SELECT policy)
-- governs which rows that command can touch and what its RETURNING output
-- contains. Collapsing update/delete into a single `for all` policy would
-- fold their owner-OR-admin clause into the SELECT path too (permissive
-- policies for the same command OR together), silently letting an admin
-- SELECT/list another identity's still-personal view — the read policy's
-- owner clause must have NO admin escape hatch. Splitting the commands out
-- keeps "admin can unshare/delete another identity's shared view" (L-06)
-- true WITHOUT granting admin general browse access to personal views.
alter table saved_views enable row level security;

create policy "select saved_views" on saved_views for select using (
  workspace_id = nopm_current_workspace()
  and (scope = 'shared' or owner_id = auth.uid())
);

create policy "insert saved_views" on saved_views for insert with check (
  workspace_id = nopm_current_workspace()
  and nopm_current_role() <> 'viewer'
);

-- The admin escape is scoped to SHARED views only (adversarial-verify fix):
-- an unscoped admin branch would let an admin PATCH/DELETE another identity's
-- PERSONAL view via direct PostgREST with the browser JWT — blind writes to
-- rows the SELECT policy deliberately hides from them. Admin authority over
-- shared workspace furniture (L-06 unshare/delete) survives; personal views
-- are owner-writable only, at every layer.
create policy "update saved_views" on saved_views for update
  using (
    workspace_id = nopm_current_workspace()
    and nopm_current_role() <> 'viewer'
    and (owner_id = auth.uid() or (nopm_current_role() = 'admin' and scope = 'shared'))
  )
  with check (
    workspace_id = nopm_current_workspace()
    and nopm_current_role() <> 'viewer'
    and (owner_id = auth.uid() or (nopm_current_role() = 'admin' and scope = 'shared'))
  );

create policy "delete saved_views" on saved_views for delete using (
  workspace_id = nopm_current_workspace()
  and nopm_current_role() <> 'viewer'
  and (owner_id = auth.uid() or (nopm_current_role() = 'admin' and scope = 'shared'))
);
