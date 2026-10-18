-- NoPM · 0060 mfa_replay_guard — remember the last accepted TOTP time-step (D-ACC-19).
--
-- A TOTP code stays valid for its whole 30-second step, so a code that was just
-- accepted (or shoulder-surfed / intercepted) could be replayed inside the same
-- step. user_mfa.last_totp_step stores the highest step number (unix seconds / 30)
-- already accepted for the account; the API accepts a code only if its step is
-- strictly greater, with a conditional UPDATE so two concurrent submissions of
-- the same code cannot both pass.
--
-- Additive and nullable: existing rows keep working (null = no code used yet).

alter table user_mfa add column if not exists last_totp_step bigint;

comment on column user_mfa.last_totp_step is
  'Highest TOTP time-step (unix seconds / 30) already accepted for this account; a code from the same or an older step is rejected as a replay. NULL = none used yet.';
