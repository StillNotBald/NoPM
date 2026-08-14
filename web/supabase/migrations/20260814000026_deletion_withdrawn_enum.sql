-- Maker withdrawal (owner decision 2026-08-14): a requester may withdraw their
-- own still-pending deletion request. Step 1 of 2: the enum value must land in
-- its own migration — Postgres forbids USING a value added by ALTER TYPE in the
-- same transaction, and the runner wraps each file in one.
alter type deletion_status add value if not exists 'withdrawn';
