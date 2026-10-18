-- NoPM · 0090 risks.category deprecation (audit gap K1, CR-2026-10-18-01 A4).
--
-- risks.category (free text, 0005) duplicated risks.risk_category (enum, 0008 /
-- 0085). The API no longer accepts, selects or returns it. The column stays so
-- no data is lost; a later release drops it.

comment on column risks.category is
  'deprecated 2026-10-18: use risk_category; dropped in a later release';
