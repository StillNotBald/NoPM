-- NoPM · 0052 api_tokens_kind — mark ephemeral assistant tokens with a column, not a name.
--
-- THE DEFECT. The in-app assistant mints a short-lived api_tokens row per chat
-- turn (lib/assistant/token.ts) named "AI Assistant · <user>", and GET
-- /api/tokens hid every row whose NAME started with that text so the human
-- Tokens list is not flooded with one row per turn. The name is free text a
-- manager types: a token deliberately named "AI Assistant · build" was hidden
-- from the inventory (R1, s1.mjs S1.hide) and could only be revoked by id. A
-- hiding rule that anyone with token-create can trigger is a hole in the very
-- list that is meant to show every credential.
--
-- THE FIX. `kind` records HOW a token came to exist. Only the assistant's own
-- mint path sets 'assistant'; POST /api/tokens has no way to (its schema has no
-- `kind` field and the column defaults to 'user'), so no caller can hide a
-- token by choosing a name. The list hides kind = 'assistant' and nothing else.
--
-- BACKFILL. Rows minted before this migration carry only the name. They are
-- marked 'assistant' only when they ALSO look like the assistant's mint: the
-- exact name prefix and an expiry of at most an hour after creation (the
-- assistant's fixed 1-hour TTL). A hand-made token with that name but no expiry
-- or a longer one stays 'user' and becomes visible. The middle dot is written
-- as chr(183) so the file stays ASCII.
--
-- No index: api_tokens is small, always filtered by workspace_id first.
-- RLS is unchanged (api_tokens has RLS on and no policy: service role only).
-- Re-running this file is safe: every statement is idempotent.

alter table api_tokens add column if not exists kind text not null default 'user';

alter table api_tokens drop constraint if exists api_tokens_kind_check;
alter table api_tokens add constraint api_tokens_kind_check check (kind in ('user', 'assistant'));

comment on column api_tokens.kind is
  'How the token came to exist: user = minted through POST /api/tokens; assistant = the per-turn ephemeral token of the in-app assistant (hidden from the human Tokens list). Set only by the assistant mint path.';

update api_tokens
   set kind = 'assistant'
 where kind = 'user'
   and name like 'AI Assistant ' || chr(183) || '%'
   and expires_at is not null
   and expires_at <= created_at + interval '61 minutes';
