-- NoPM · 0053 hub_card_integrity — a chat card can only approve what it showed.
-- Additive only, and separate from 0051 so a database that already applied 0051
-- picks it up. Nothing here touches audit_log or a governed table.

-- ── Bind every action token to the content version it was issued for ───────
-- Red-team finding: a change request can be edited after its approval card went
-- out, and a tap on the ORIGINAL card then approved the NEW content (the approver
-- never saw what they approved, and the audit row only shows the new text).
-- A token now carries the request's content version at the moment it was minted
-- (the request row's updated_at, which its trigger bumps on every edit). Taking
-- the action compares it with the request's current version and refuses on any
-- difference, without deciding. NULL = no version to check (request kinds with
-- no editable content, and tokens minted before this migration).
--
-- superseded_reason says WHY a token that was stamped used (used_at) was retired
-- without being clicked: 'changed' = the request was edited and a new card
-- replaced it, so a late tap on the old card is answered "this request changed"
-- rather than "already decided". NULL = used, or retired by a decision.
alter table action_tokens
  add column approval_version text,
  add column superseded_reason text
    check (superseded_reason is null or superseded_reason in ('changed'));

-- ── Per-approver hourly card budget ────────────────────────────────────────
-- One low-privilege maker token can raise requests faster than any human can
-- read the cards. The hub counts an approver's cards over the last hour and,
-- past the budget, sends ONE roll-up message instead of more cards. This index
-- serves that count.
create index integration_deliveries_card_budget_idx
  on integration_deliveries (recipient_profile_id, created_at)
  where kind = 'approval_card';

-- One roll-up per approver per hour. payload.notice_hour is the hour bucket
-- (UTC, truncated), so concurrent emits cannot queue two of them.
create unique index uniq_backlog_notice_per_hour
  on integration_deliveries (connector_id, recipient_profile_id, (payload->>'notice_hour'))
  where kind = 'bot_reply' and payload->>'notice' = 'backlog' and status <> 'superseded';
