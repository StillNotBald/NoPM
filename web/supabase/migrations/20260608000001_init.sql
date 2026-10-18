-- NoPM · 0001 init — extensions, base enums, workspaces, profiles, scope helpers, RLS foundation.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ── Enums ──────────────────────────────────────────────────────────────────
create type member_role as enum ('admin', 'manager', 'member', 'viewer');
create type rag_status  as enum ('not_started', 'red', 'amber', 'green', 'complete');
create type actor_type  as enum ('user', 'token');

-- ── updated_at trigger fn (shared) ─────────────────────────────────────────
create or replace function nopm_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── Workspaces ─────────────────────────────────────────────────────────────
create table workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  created_at timestamptz not null default now()
);

-- ── Profiles (one per auth user, belongs to a workspace) ───────────────────
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email        text,
  display_name text,
  role         member_role not null default 'member',
  created_at   timestamptz not null default now()
);
create index on profiles(workspace_id);

-- ── Scope helpers (SECURITY DEFINER → read profiles without RLS recursion) ──
create or replace function nopm_current_workspace()
returns uuid language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where id = auth.uid()
$$;

create or replace function nopm_current_role()
returns member_role language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table workspaces enable row level security;
alter table profiles   enable row level security;

create policy "members read their workspace" on workspaces
  for select using (id = nopm_current_workspace());

create policy "members read profiles in workspace" on profiles
  for select using (workspace_id = nopm_current_workspace());
create policy "user updates own profile" on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
