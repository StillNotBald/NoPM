-- NoPM · 0039 invites — link-based invites + unified identity provisioning
-- (L-47/L-48, F2b T7). devops-wave1/README.md:46: invites are LINK-based
-- (no email dependency, audited + revocable) — the accept flow below is the
-- FIRST place in src/ that provisions an auth.users row (previously only
-- scripts/*.mjs did this — recon-identity.md §2).
--
-- Sensitive precedent (recon-identity.md §4, mirrors api_tokens/0002): RLS
-- enabled with ZERO policies = deny-all for anon/authenticated. Every read
-- and write goes through the audited API routes on the service-role admin
-- client — never direct PostgREST from the browser JWT.
--
-- Status is DERIVED, not stored: pending = not revoked AND accepted_at is
-- null AND expires_at > now(). The API computes this on read rather than
-- keeping a redundant status column that could drift from the three source
-- columns (same reasoning as deletion_requests NOT modeling "expired" as a
-- distinct persisted state anywhere else in this schema).
create table invites (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  email                text not null,
  role                 member_role not null default 'member',
  name                 text,
  role_title           text,
  cost_rate            numeric(12, 2) not null default 0,
  capacity_hours_per_week numeric(6, 2) not null default 40,
  token_hash           text not null unique,   -- sha-256(raw token); raw shown once
  prefix               text not null,          -- 'npi_' (distinct from api_tokens' 'npm_')
  created_by           uuid not null references profiles(id),
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null,
  revoked              boolean not null default false,
  accepted_at          timestamptz,
  accepted_profile_id  uuid references profiles(id)
);

create index on invites(workspace_id);

alter table invites enable row level security;
-- Zero policies: deny-all for anon/authenticated. Only the service-role
-- admin client (used exclusively inside route() handlers) reads/writes here.
revoke all on invites from anon, authenticated;

-- ── nopm_accept_invite ──────────────────────────────────────────────────────
-- Unified-identity accept (recon-identity.md §1 "Unified invite = 3 writes"):
-- auth.users is created by the CALLER (admin.auth.admin.createUser, in the
-- API route, BEFORE this function runs — D6) so this function only has to
-- atomically write the remaining two rows + mark the invite + audit BOTH
-- writes, all inside one transaction. This is the third write recon-identity
-- flagged as unenforced anywhere in the DB today (migration 0019's failure
-- mode: an invite that only wrote auth+profiles would silently reproduce the
-- pre-0019 identity split between login and work identity).
--
-- The invite row is locked FOR UPDATE (mirrors nopm_commit_task_deletion,
-- migration 0020) so two concurrent accept attempts against the same token
-- can't both succeed (TOCTOU) — the second one raises ALREADY_USED.
--
-- Typed exceptions the API route maps to clean HTTP statuses:
--   NOT_FOUND     (P0002) — no invite with this token hash
--   ALREADY_USED  (P0001) — already accepted, or revoked
--   EXPIRED       (P0004) — expires_at has passed
create or replace function nopm_accept_invite(
  p_token_hash   text,
  p_auth_user_id uuid,
  p_email        text,
  p_display_name text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inv       invites%rowtype;
  ts        timestamptz := now();
  v_member_id uuid;
  v_label   text := coalesce(nullif(trim(p_display_name), ''), p_email);
begin
  select * into inv from invites where token_hash = p_token_hash for update;

  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if inv.revoked or inv.accepted_at is not null then
    raise exception 'ALREADY_USED' using errcode = 'P0001';
  end if;
  if inv.expires_at <= ts then
    raise exception 'EXPIRED' using errcode = 'P0004';
  end if;

  -- 1. login identity — profiles row, id = the auth.users id the caller
  --    already created. role comes from the invite, never the request body.
  insert into profiles (id, workspace_id, email, display_name, role)
    values (p_auth_user_id, inv.workspace_id, p_email, p_display_name, inv.role);

  -- 2. work identity — resource_members row bridged to the login identity
  --    via profile_id (recon-identity.md §1 — the FK the 0019 failure mode
  --    left unenforced). name falls back to the display name the accepter
  --    chose if the inviter never set one.
  insert into resource_members (
    workspace_id, name, email, role_title, cost_rate, capacity_hours_per_week, profile_id
  ) values (
    inv.workspace_id,
    coalesce(inv.name, p_display_name),
    p_email,
    inv.role_title,
    inv.cost_rate,
    inv.capacity_hours_per_week,
    p_auth_user_id
  )
  returning id into v_member_id;

  -- 3. mark the invite consumed.
  update invites set accepted_at = ts, accepted_profile_id = p_auth_user_id where id = inv.id;

  -- 4/5. two audit rows — the domain effect (a new member joined) audited
  -- separately from the governance step itself (the invite being consumed),
  -- same two-row pattern as the deletion commit RPC (migration 0020).
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after)
    values (inv.workspace_id, 'user'::actor_type, p_auth_user_id, v_label,
            'invite.accepted', 'invite', inv.id,
            jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'accepted'));

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after)
    values (inv.workspace_id, 'user'::actor_type, p_auth_user_id, v_label,
            'member.joined', 'resource_member', v_member_id,
            null, jsonb_build_object('name', coalesce(inv.name, p_display_name), 'role', inv.role));

  return jsonb_build_object(
    'profile_id', p_auth_user_id,
    'member_id', v_member_id,
    'workspace_id', inv.workspace_id
  );
end;
$$;

revoke execute on function nopm_accept_invite(text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_accept_invite(text, uuid, text, text) to service_role;
