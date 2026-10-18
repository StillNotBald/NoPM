-- NoPM · 0104 audit_hash_chain — tamper evidence for audit_log (assumption A7, finding M1).
--
-- THE GAP. 0006/0050 make audit_log append-only for every API path, but a database
-- owner can still drop a trigger, edit a row and put the trigger back, and nothing
-- would show it. This migration chains every row to the one before it, so any later
-- edit, deletion in the middle, or re-ordering is detectable by recomputing the chain.
--
-- HOW IT WORKS.
--   * Each row stores prev_hash (the row_hash of the previous row IN THE SAME
--     WORKSPACE; null for the first row) and row_hash =
--         sha256( coalesce(prev_hash,'') || '|' || canonical(row) )   as lowercase hex.
--   * canonical(row) is nopm_audit_canonical(): the JSON array text of
--     (id, workspace_id, actor_type, actor_id, actor_label, principal_id, action,
--      target_type, target_id, before, after, channel, request_id, created_at in UTC,
--      via_connector_id, external_event_id, external_actor_ref, chain_seq).
--     jsonb text is deterministic (sorted keys, fixed spacing), NULL becomes JSON null.
--     src/lib/audit/hash.test.ts reimplements it in TypeScript and pins a fixture
--     hash, so changing this function without changing that test fails the build.
--   * chain_seq is a per-workspace insertion counter. created_at is the transaction
--     START time, so two concurrent transactions can commit out of created_at order;
--     the chain follows insertion order, which chain_seq records.
--   * A BEFORE INSERT trigger (trg_audit_chain) fills all three columns. It takes a
--     per-workspace advisory lock first, so two concurrent inserts into one workspace
--     are serialised and cannot both chain to the same predecessor. Values supplied
--     by the caller are overwritten.
--   * nopm_audit_verify_chain(workspace, from) recomputes the chain and reports the
--     first row that does not match, over the newest 50000 rows by default. Service role only;
--     GET /api/audit/verify calls it (at most once per workspace per 5 minutes).
--
-- THE ONE SANCTIONED UPDATE. Existing rows have no hash. Section 2 backfills them in
-- (created_at, id) order per workspace. That is the only UPDATE audit_log has ever
-- allowed: it touches only the three new chain columns and no business column. To do
-- it, section 2 switches the update-blocking trigger off and section 3 switches it
-- back on, in this same file and transaction, so the migration ends with every guard
-- enabled. immutability.test.ts recognises exactly this pair in this file and nowhere
-- else, and asserts it is paired and that no other file does the same.
--
-- WHAT THIS DOES NOT PROVE (stated plainly). A database owner who rewrites a row and
-- then recomputes every later hash in that workspace produces a valid-looking chain.
-- Defeating that needs the latest row_hash kept somewhere the owner cannot write
-- (an email, a ticket, a log line). GET /api/audit/verify returns head_hash for that
-- purpose. Deleting the newest rows is likewise only detectable against such a copy.
--
-- DEPLOY ORDER. Apply this migration BEFORE the build that shows the Trust Center
-- badge. The backfill runs once; re-running the file is safe (it only hashes rows
-- that still have no hash). Older builds keep working: they never write these columns.
--
-- ROLLBACK (do not, unless audited): remove trg_audit_chain; the columns can stay.
-- Rows written meanwhile would then be unchained.

-- ── 1. Columns and the canonical text / hash functions ──────────────────────
alter table audit_log
  add column if not exists prev_hash  text,
  add column if not exists row_hash   text,
  add column if not exists chain_seq  bigint;

comment on column audit_log.prev_hash is 'row_hash of the previous audit row in this workspace (null for the first); set by trg_audit_chain';
comment on column audit_log.row_hash  is 'sha256 hex over prev_hash and the canonical row text (see 0104); set by trg_audit_chain';
comment on column audit_log.chain_seq is 'per-workspace insertion counter, 1-based and gapless; set by trg_audit_chain';

create or replace function nopm_audit_canonical(r audit_log)
  returns text
  language sql
  immutable
  set search_path = public
as $$
  select jsonb_build_array(
    r.id::text,
    r.workspace_id::text,
    r.actor_type::text,
    r.actor_id::text,
    r.actor_label,
    r.principal_id::text,
    r.action,
    r.target_type,
    r.target_id::text,
    r.before,
    r.after,
    r.channel,
    r.request_id,
    to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    r.via_connector_id::text,
    r.external_event_id,
    r.external_actor_ref,
    r.chain_seq
  )::text
$$;

create or replace function nopm_audit_row_hash(p_prev text, r audit_log)
  returns text
  language sql
  immutable
  set search_path = public
as $$
  select encode(sha256(convert_to(coalesce(p_prev, '') || '|' || nopm_audit_canonical(r), 'utf8')), 'hex')
$$;

revoke execute on function nopm_audit_canonical(audit_log) from public, anon, authenticated;
revoke execute on function nopm_audit_row_hash(text, audit_log) from public, anon, authenticated;
grant  execute on function nopm_audit_canonical(audit_log) to service_role;
grant  execute on function nopm_audit_row_hash(text, audit_log) to service_role;

-- ── 2. Backfill existing rows (the only UPDATE audit_log ever allows) ───────
alter table audit_log disable trigger trg_audit_no_update;

do $$
declare
  w       record;
  r       audit_log%rowtype;
  v_prev  text;
  v_seq   bigint;
begin
  for w in select distinct workspace_id from audit_log where row_hash is null loop
    select a.row_hash, a.chain_seq into v_prev, v_seq
      from audit_log a
     where a.workspace_id = w.workspace_id and a.row_hash is not null
     order by a.chain_seq desc
     limit 1;
    v_seq := coalesce(v_seq, 0);

    for r in
      select * from audit_log a
       where a.workspace_id = w.workspace_id and a.row_hash is null
       order by a.created_at, a.id
    loop
      v_seq := v_seq + 1;
      r.chain_seq := v_seq;
      r.prev_hash := v_prev;
      r.row_hash  := nopm_audit_row_hash(v_prev, r);
      update audit_log
         set chain_seq = r.chain_seq, prev_hash = r.prev_hash, row_hash = r.row_hash
       where id = r.id;
      v_prev := r.row_hash;
    end loop;
  end loop;
end $$;

-- ── 3. Re-arm the guard, then lock the new columns down ─────────────────────
alter table audit_log enable trigger trg_audit_no_update;

alter table audit_log
  alter column row_hash  set not null,
  alter column chain_seq set not null;

create unique index if not exists audit_log_chain_idx on audit_log (workspace_id, chain_seq);

-- ── 4. The insert trigger ───────────────────────────────────────────────────
create or replace function nopm_audit_chain()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_prev text;
  v_seq  bigint;
begin
  -- One writer per workspace at a time: the read of the previous row and this
  -- insert must not interleave with another insert into the same workspace.
  perform pg_advisory_xact_lock(hashtext(new.workspace_id::text));

  select a.row_hash, a.chain_seq into v_prev, v_seq
    from audit_log a
   where a.workspace_id = new.workspace_id
   order by a.chain_seq desc
   limit 1;

  new.prev_hash := v_prev;
  new.chain_seq := coalesce(v_seq, 0) + 1;
  new.row_hash  := nopm_audit_row_hash(v_prev, new);
  return new;
end $$;

drop trigger if exists trg_audit_chain on audit_log;
create trigger trg_audit_chain before insert on audit_log
  for each row execute function nopm_audit_chain();

-- ── 5. Verification ─────────────────────────────────────────────────────────
-- Recomputes one workspace's chain in order and reports the first row that does not
-- match (altered content, broken link, or a gap in chain_seq from a removed row).
--
-- BOUNDED. It checks at most the newest p_limit rows (default 50000, clamped to
-- 1..1000000) so one call cannot walk an unbounded table. The oldest row it checks is
-- anchored on the prev_hash that row stores: it proves the checked window is internally
-- consistent and joined to itself, not that rows older than the window are intact
-- (first_seq tells the caller where the window began; run again with a larger p_limit
-- to cover more). With p_from it also skips rows created before that instant, and uses
-- the stored hash of the row before the first checked one as the anchor.
-- Returns ok = true with the number of rows checked, or ok = false with the first bad row.
create or replace function nopm_audit_verify_chain(
  p_workspace_id uuid,
  p_from         timestamptz default null,
  p_limit        integer default 50000
)
  returns table (ok boolean, checked bigint, first_bad_id uuid, first_bad_at timestamptz, first_seq bigint)
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  r         audit_log%rowtype;
  v_limit   integer := least(greatest(coalesce(p_limit, 50000), 1), 1000000);
  v_min_seq bigint;
  v_prev    text;
  v_seq     bigint;
  v_started boolean := false;
  v_first   bigint;
  v_count   bigint := 0;
begin
  select min(w.chain_seq) into v_min_seq
    from (select a.chain_seq from audit_log a
           where a.workspace_id = p_workspace_id
           order by a.chain_seq desc
           limit v_limit) w;

  for r in
    select * from audit_log a
     where a.workspace_id = p_workspace_id and a.chain_seq >= v_min_seq
     order by a.chain_seq
  loop
    if not v_started then
      if p_from is not null and r.created_at < p_from then
        v_prev := r.row_hash;
        v_seq  := r.chain_seq;
        continue;
      end if;
      v_started := true;
      v_first   := r.chain_seq;
      -- The window starts mid-chain: trust the stored link of its oldest row as the anchor.
      if v_seq is null and r.chain_seq > 1 then
        v_prev := r.prev_hash;
        v_seq  := r.chain_seq - 1;
      end if;
    end if;

    -- v_seq is null only for the very first row of the chain: it must be number 1
    -- with no predecessor. Otherwise it must follow the previous row without a gap.
    if (v_seq is null and r.chain_seq <> 1)
       or (v_seq is not null and r.chain_seq <> v_seq + 1)
       or r.prev_hash is distinct from v_prev
       or r.row_hash is distinct from nopm_audit_row_hash(v_prev, r) then
      return query select false, v_count, r.id, r.created_at, v_first;
      return;
    end if;

    v_count := v_count + 1;
    v_prev  := r.row_hash;
    v_seq   := r.chain_seq;
  end loop;

  return query select true, v_count, null::uuid, null::timestamptz, v_first;
end $$;

revoke execute on function nopm_audit_verify_chain(uuid, timestamptz, integer) from public, anon, authenticated;
grant  execute on function nopm_audit_verify_chain(uuid, timestamptz, integer) to service_role;
