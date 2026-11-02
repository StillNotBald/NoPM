-- NoPM · 0120 telegram_connector (ADR 0020, R-190..R-197).
--
-- A Telegram bot as a second chat connector on the integration hub. Additive only:
--   1. integration_connectors.kind accepts 'telegram'.
--   2. audit_log.channel accepts 'telegram' (server-derived, never a caller header), and so do the
--      audited SQL functions that validate the channel list.
--   3. api_tokens.kind accepts 'telegram' (per-action tokens minted by the bot; hidden from the Tokens list).
--   4. chat_pending: durable state of a chat (open ask, preview, pick list, update-id dedupe).
--
-- Not run against any database by the author. Rehearse on a copy first (step 2 rewrites functions; the
-- post-condition block raises if any channel-checking function still omits 'telegram').

-- ── 1. connector kind ──────────────────────────────────────────────────────
alter table integration_connectors drop constraint if exists integration_connectors_kind_check;
alter table integration_connectors
  add constraint integration_connectors_kind_check check (kind in ('lark', 'github', 'telegram'));

-- ── 2. audit channel ───────────────────────────────────────────────────────
alter table audit_log drop constraint audit_channel_check;
alter table audit_log
  add constraint audit_channel_check
  check (channel is null or channel in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark', 'github', 'telegram'))
  not valid;
alter table audit_log validate constraint audit_channel_check;

-- Every audited SQL function that validates its channel carries a literal allow-list, in either form:
--   channel not in ('ui', ..., 'lark')                (deletion / decide / rebaseline / sign-off RPCs)
--   channel not in ('ui', ..., 'lark', 'github')      (audit_insert, mutate_audited, tier decide)
-- Re-create every such function with 'telegram' added to the list. Nothing is removed from any list.
-- Only the literal changes; the rest of each body comes from pg_get_functiondef untouched. The pattern
-- skips any list that already names telegram, so re-running the migration changes nothing.
do $$
declare
  r   record;
  def text;
  new_def text;
begin
  for r in
    select p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
  loop
    def := pg_get_functiondef(r.oid);
    new_def := regexp_replace(
      def,
      'channel not in \((?![^)]*telegram)([^)]*''lark''[^)]*)\)',
      'channel not in (\1, ''telegram'')',
      'g'
    );
    if new_def <> def then
      execute new_def;
    end if;
  end loop;
end
$$;

-- Post-condition: no function may list 'lark' as an accepted channel without also listing 'telegram'.
-- A function this migration could not rewrite fails the whole migration instead of failing at approval time.
do $$
declare
  r       record;
  missing text := '';
begin
  for r in
    select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
  loop
    if r.def ~ 'channel not in \((?![^)]*telegram)[^)]*''lark''[^)]*\)' then
      missing := missing || ' ' || r.proname;
    end if;
  end loop;
  if missing <> '' then
    raise exception 'telegram channel missing from allow-list of:%', missing;
  end if;
end
$$;

-- ── 3. per-action bot tokens ───────────────────────────────────────────────
alter table api_tokens drop constraint if exists api_tokens_kind_check;
alter table api_tokens add constraint api_tokens_kind_check check (kind in ('user', 'assistant', 'telegram'));

-- ── 4. chat_pending ────────────────────────────────────────────────────────
-- One row per open chat step, plus one 'seen' row per processed update (dedupe). Rows are claimed with a
-- compare-and-swap on `version`, so a double tap or a Telegram retry writes once. Expiry is lazy: nothing
-- deletes a row on a timer; the bot checks expires_at when the user next writes.
create table chat_pending (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  connector_id uuid not null references integration_connectors(id) on delete cascade,
  chat_id      text not null,
  kind         text not null check (kind in ('seen', 'ask', 'preview', 'pick', 'approval')),
  dedupe_key   text,
  payload      jsonb not null default '{}'::jsonb,
  version      integer not null default 1,
  status       text not null default 'open' check (status in ('open', 'claimed', 'done', 'cancelled', 'failed')),
  profile_id   uuid references profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);
create unique index chat_pending_dedupe_idx on chat_pending(connector_id, dedupe_key) where dedupe_key is not null;
create index chat_pending_chat_idx on chat_pending(connector_id, chat_id, status);
create index chat_pending_workspace_idx on chat_pending(workspace_id, created_at desc);
create index chat_pending_expiry_idx on chat_pending(expires_at);

-- RLS: deny-all (service role only), like every other integration table.
alter table chat_pending enable row level security;
revoke all on chat_pending from anon, authenticated;
