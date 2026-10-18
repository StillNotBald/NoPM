-- Fix: the original `check (allocation_pct between 0 and 100)` made it impossible
-- to record an over-allocation (>100%) — which is exactly what the flagship
-- resource-clash demo depends on. Relax the upper bound 100 -> 500 (API Zod is
-- tightened to match). Purely a constraint swap; no data change.
alter table allocations drop constraint if exists allocations_allocation_pct_check;
alter table allocations add constraint allocations_allocation_pct_check
  check (allocation_pct >= 0 and allocation_pct <= 500);
