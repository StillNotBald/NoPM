# OpenAPI and llms.txt wording - W5-E (external audit anchor)

Apply in `web/src/app/api/openapi.json/route.ts` and `web/src/app/llms.txt/route.ts` during the docs pass.

## GET /audit/verify (R-169)

- Response body gains, next to `ok`, `checked`, `first_seq`, `limit`, `first_bad_id`, `first_bad_at`, `from`, `head_hash`, `verified_at`:
  - `chain_ok` (boolean): the plain result of recomputing the hash chain.
  - `ok` (boolean): `chain_ok` AND the anchor state is not `mismatch`. A mismatch makes `ok` false even when the chain itself is sound.
  - `all_clear` (boolean): true only when `ok` is true and `anchor.state` is neither `mismatch` nor `unreachable`.
  - `anchor` (object): `state` enum `not_anchored | anchored | behind | mismatch | unreachable`; `chain_seq` (integer or null, the newest anchored position); `anchored_at` (ISO 8601 or null); `row_count` (integer or null); `rows_behind` (integer or null, only for `behind`); `since` (ISO 8601 or null, when a `mismatch` or `unreachable` streak began).
- Description paragraph: "If the deployment keeps a copy of the chain head in a second database (`NOPM_ANCHOR_DB_URL`), the call compares the live chain with the newest copy and, when the chain verified and nothing diverged, saves the head that includes this check's own audit row. `not_anchored` means nothing is configured or this workspace was never anchored. `anchored` means the live row at the newest anchored position has the anchored hash and it is the head. `behind` is the same with newer rows since. `mismatch` means rows were removed or rewritten since the anchor. `unreachable` means the copy could not be read or written; nothing else is affected. 'Anchored' is only ever reported after a successful comparison. A token, member or viewer is still 403; the five-minute throttle is unchanged and a throttled call does not touch the copy."
- The `audit.verified` audit row's `after` now also carries `chain_ok` and `anchor` (`state`, `chain_seq`, `anchored_at`, `rows_behind`: the anchor state before this check).

## Audit actions (glossary paragraph in the audit section)

- `audit.anchored`: first anchor of a workspace, or first success after a failure streak. Not written on a routine success.
- `audit.anchor_failed`: one row per failure streak (the outside copy could not be written or read).
- `audit.anchor_mismatch`: one row per mismatch streak (the live chain differs from the outside copy).

## Cron (GET /integrations/cron)

- Response `data` gains `anchor`: `{ configured, workspaces, anchored, skipped, mismatched, failed, skippedForDeadline }` (all zero and `configured: false` when `NOPM_ANCHOR_DB_URL` is unset).

## llms.txt

- Replace the `GET /audit/verify` line's result list with `{ ok, chain_ok, all_clear, checked, first_seq, limit, first_bad_id, first_bad_at, from, head_hash, verified_at, anchor: { state not_anchored|anchored|behind|mismatch|unreachable, chain_seq, anchored_at, row_count, rows_behind, since } }` and append: "`ok` is false on an anchor mismatch even when `chain_ok` is true; never treat `anchor.state` of `mismatch` or `unreachable` as an all-clear; no route writes an anchor on demand (the daily job and a successful check do)".
- Error codes: none new.
