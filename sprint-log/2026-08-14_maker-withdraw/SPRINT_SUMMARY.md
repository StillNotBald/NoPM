# Sprint: maker-withdraw on deletion requests + pre-demo deploy

**Date:** 2026-08-14
**Intent:** Owner decision — the maker may withdraw their own pending deletion request (the open question from the test-hardening sprint). Ship it, then deploy everything (including the four journey fixes from `662902c`) ahead of the founder demo.

## What shipped

### Maker withdrawal (R-03 extension)
- **DB (2 migrations):** `..026` adds `withdrawn` to `deletion_status` (own file — PG forbids using a fresh enum value in the same txn); `..027` re-creates `maker_checker_different` so withdrawn rows require `approved_by_id IS NULL` — four-eyes still binds every checker decision.
- **API:** new `POST /api/deletion-requests/[id]/withdraw` — scope `task:delete:request`, requester-only (403 otherwise), pending-only (422), audited as `deletion_request.withdrawn`. Reject stays checker-only (self-reject 422) — guard symmetry preserved.
- **Contract surfaces, same commit:** OpenAPI path + status enum + stale "self-rejection is allowed" text fixed; llms.txt endpoint list + maker-checker narrative; list-route `?status=withdrawn`; Trust Center action legend. Drift locks (openapi/llms coverage tests) pass: 1,021 tests green.
- **UI:** Approvals page now distinguishes own requests — maker sees a Withdraw button (+ "a different person must decide it" note) instead of Approve/Reject that would 403/422.
- **E2E:** Tier-2 governed journey extended — self-reject 422 → withdraw 200 → re-withdraw 422 (terminal) → re-request (unique-pending index freed) → foreign withdraw blocked → checker rejects.

### Gates
vitest 36 files / 1,021 tests green · `tsc --noEmit` clean · `rtm:verify` OK (R-03 row updated in REQUIREMENTS + TRACEABILITY, same commit) · production build green.

## Deploy
Migrations 026+027 applied to the live Supabase project; `vercel --prod` deploy of this commit (carrying the four `662902c` journey fixes that were pending deploy); live funnel re-verified post-deploy (health + demo-login + auth-smoke).

## RTM
R-03 acceptance text extended (withdraw); TRACEABILITY R-03 row gains the withdraw route, migration 027, and the e2e journey as verification.
