# RTM rows - Pre-0 shared audit-insert helper

Pre-0 has no R-ID of its own. It is infrastructure for R-161 to R-165, whose dedicated RPCs all write their audit row through this helper.

## REQUIREMENTS.md bullet

- **Pre-0 (infrastructure for R-161 to R-165, no R-ID)** Shared SQL audit-insert helper. Acceptance: (a) migration 0107 defines `nopm_audit_insert(p_workspace_id uuid, p_audit jsonb, p_target_id uuid, p_before jsonb, p_after jsonb) returns uuid`, which inserts exactly one `audit_log` row with the same 15 columns as `nopm_mutate_audited` (action, actor, channel, request id, principal, connector provenance) and never sets `prev_hash`, `row_hash` or `chain_seq` (the 0104 trigger fills them); (b) it accepts a user actor, a connector actor and the system actor (nil actor id, token type, `system:` label, no principal; the nil id is refused for anything else); (c) it rejects an action that is not lower-case verb.noun (P0057), a null actor label (P0058, a blank label is accepted, as writeAudit and 0103 do), a channel outside ui, api, cli, mcp, assistant, lark, github (P0005, as 0103), and a missing actor type or target type (P0058, P0059); (d) it is security definer with a pinned search_path and executable by the service role only; (e) the migration creates only this function, is idempotent and safe on live rows; (f) `web/src/lib/audit/sql-audit-insert.ts` builds the identical argument object from the `writeAudit` input type (`buildAuditInsertArgs`, `buildRpcAudit`) and offers `callAuditInsert`, and a text-drift test pins both to the migration. Outcome: easier reporting. Release order: apply 0107 before 0108. — **DONE** (wave 5, 2026-10-18)

## TRACEABILITY.md row

| Pre-0 | Shared SQL audit-insert helper (infrastructure for R-161 to R-165) | DONE | `web/supabase/migrations/20261018000107_audit_insert_helper.sql`, `web/src/lib/audit/sql-audit-insert.ts` | `web/src/lib/audit/sql-audit-insert.test.ts` |

## Notes for the lead

- The lead applies the bullet and the row; no R-ID was minted for Pre-0.
- The signature follows PLAN Pre-0. Callers pass `p_audit` from `buildRpcAudit` (a thin wrapper over `buildAuditArg`); before, after and target id are explicit parameters, so `p_audit` keys named before, after or target_id are ignored by the helper.
- Rehearsed against the local database: dry run, apply, second apply skipped, then system and user calls inside a rolled-back transaction. The chain trigger filled `chain_seq` and `row_hash` and linked the second row to the first. Rejections checked: bad action, bad channel, nil actor id on a user.
