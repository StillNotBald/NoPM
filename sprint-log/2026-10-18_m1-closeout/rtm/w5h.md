# RTM rows - W5-H documentation (R-178 and R-179, documentation half)

## REQUIREMENTS.md bullets

- **R-178 (documentation half)** The emergency retro text in the public contract says "retired" or "history only" and never "deprecated". Acceptance: (a) `openapi.json/route.ts` and `llms.txt/route.ts` describe `emergency_retro_hours` as retired (PATCH accepts and ignores it; GET no longer returns it), and `retro_due_at`, `retro_decided_at`, `retro_outcome` and `retro_overdue` as history only; (b) the change-request list, create, review, export, audit-pack and cron text agrees with W5-I's code. **DONE**
- **R-179 (documentation half)** No document under `docs/` quotes the old seed login addresses (W5-I found none); nothing to change. **DONE**
- **Documentation for R-161 to R-177 (no new R-ID).** The OpenAPI document, llms.txt, `web/mcp/README.md`, `docs/adr/0018-atomic-audit-and-external-anchor.md`, `docs/use-cases/UC-35-deletion-by-request-all-registers.md`, UC-27 and UC-33, and the Trust Center paragraph of the governance guide describe the wave 5 contract. The three known red tests (attach_evidence, five delete-scope checks, coverage lists) are green.

## TRACEABILITY.md rows

| R-178 | Retro leftovers retired (documentation half) | DONE | `web/src/app/api/openapi.json/route.ts`, `web/src/app/llms.txt/route.ts` | `web/src/lib/api/openapi-coverage.test.ts`, `web/src/lib/api/llms-coverage.test.ts` |
| R-179 | Seed logins on a neutral domain (documentation half) | DONE | none (no document quoted the old addresses) | none |

(The R-178 and R-179 rows already exist from W5-I; append the two files above to their Code column and the two tests to their Test column. The other docs are not R-ID rows.)

## Notes applied (every `rtm/*-openapi-notes.md`)

| Note | Item | Result |
|---|---|---|
| w5a | Atomic wording on the deletion verbs (project, task, risk, issue, expense, document, milestone), withdraw, reject, change-request create/patch/delete, rebaseline create; llms governance line | applied |
| w5b | MFA enroll/verify/challenge/disable sentences, attempt-budget sentence, backup code, connectors and GitHub connector, invite sweep, chat-account link, audit action list, llms line | applied. The OpenAPI audit action list is on `GET /audit`; the Lark link wording is on the link-code operation (`createIdentityLinkCode`) |
| w5c | Cron snapshots and integrations cron wording, system actors, weekly report claim, audit action actor wording, llms line | applied |
| w5d | Task `blocker_reason` and `eta` (create, update, list defaults, clear with null, 422); members export column list and the admin-only `last_sign_in_at` sentence; llms lines | applied. The create and update bodies come from the task validators, so the schema already carried both fields; only the descriptions were added |
| w5e | `GET /audit/verify` response fields (`chain_ok`, `all_clear`, `anchor` object), description paragraph, `audit.verified` after, three anchor audit actions, cron `anchor` summary, llms verify line | applied |
| w5f | `POST /change-requests/{id}/evidence` (operationId `attachChangeRequestEvidence`, body generated from the route's own validator, 200/201/403/404/422 with the three evidence codes), GET wording, llms line, MCP tool list, lean documents list (`view`, `fields`, summary columns, `storage_path` never returned) | applied |
| w5g | Five DELETE operations rewritten to the milestone pattern (202, body with `reason`, new request scopes in the first scope clause, per-kind sentences); `GET /deletion-requests` target types; approve scope text and extra 422 codes; withdraw; review kinds with read gating; intro scope list; llms deletion section and approve scopes; MCP tool names | applied |
| w5i | `emergency_retro_hours` removed from the GET policy text, kept as retired on PATCH, "deprecated and has no effect" reworded | applied (reworded to "retired" everywhere, plus the other retro lines PR-24 listed) |

## Error codes and audit actions now in the contract

- API codes added to the llms.txt list: `pending_rebaseline_exists`, `evidence_not_accepted`, `evidence_linked_elsewhere`, `evidence_link_invalid`, `sprint_not_planned`, `invalid_assigned_approver`. `has_timesheet_records` and `children_changed` were already listed.
- The SQL error codes (P0057 to P0064, P0070, P0071, P0085) are database-internal. They are mapped to the API codes above by the routes and are not part of the public contract, so they are not written into OpenAPI.
- Audit actions added to the `GET /audit` description: the MFA, connector, invite, link, assistant token, clash, overspend, snapshot and weekly report actions from W5-B and W5-C, the five `<entity>.delete_requested` and `<entity>.delete` pairs, and `audit.anchored`, `audit.anchor_failed`, `audit.anchor_mismatch`.

## Decisions for the lead

- **UC number.** The brief asked for `UC-33-deletion-by-request-all-registers.md`. UC-33 already exists (chain verification), so the new use case is UC-35. UC-33 itself was extended with the anchor. If you want a different number, rename the file and the README row.
- **PR-24 retro lines.** The deferred retro text fixes were applied by search and not by line number, because the earlier edits moved the lines. They now say "retired" or "history only".
- **UAT-PLAN fill and CUTOVER/11 extension.** PLAN lists these for W5-H. This brief allows only a cross-reference in `CUTOVER/11-AUDIT-GAPS.md`, which I added (a pointer to 12, 13 and 14). I did not touch `UAT-PLAN.md`.
