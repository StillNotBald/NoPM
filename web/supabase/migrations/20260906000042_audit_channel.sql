-- NoPM · 0042 audit_channel (R-82).
--
-- NoPM does not replace Jira, Slack or Teams; it is the governed record beside
-- them. Lite and fast. Not ClickUp. This migration gives every audit_log row
-- provenance: which CLIENT wrote it (ui/api/cli/mcp/assistant) and a
-- per-request correlation id, so CLI/MCP/assistant/UI provenance is provable,
-- not label-inferred from actor_type alone.
--
-- Both columns are nullable and additive — no existing row or query is
-- affected. `channel` is CALLER-ASSERTED (declared via the X-NoPM-Client
-- header, defaulted server-side per actor type when absent/unrecognized) —
-- it is NOT part of the authorization decision and never supersedes the
-- token/session identity, which stays the authoritative actor. `request_id`
-- is a per-request correlation id (X-Request-Id, echoed back on the
-- response) generated server-side when the caller didn't supply one, so
-- every row can always be tied back to the exact request that wrote it.
--
-- Triggers and RLS on audit_log are untouched — the append-only enforcement
-- (SECURITY.md "Audit immutability") applies unchanged to these new columns.

alter table audit_log add column channel text, add column request_id text;

alter table audit_log
  add constraint audit_channel_check
  check (channel is null or channel in ('ui', 'api', 'cli', 'mcp', 'assistant'));

comment on column audit_log.channel is 'declared client (caller-asserted via X-NoPM-Client; token identity stays authoritative)';
comment on column audit_log.request_id is 'per-request correlation id (X-Request-Id, echoed in the response)';
