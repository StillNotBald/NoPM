# Sprint Summary — 2026-06-08_wave-b-governance-cli

**TL;DR:** Full governance surface (tokens, TOTP MFA, maker-checker, Control-Tower) + nopm CLI; four-eyes loop verified 8/8.

## Declared goals
- Token mint/list/revoke + TOTP MFA enroll/verify/disable (R-02, R-05)
- Maker-checker delete-task: request→approve/reject, self-approval denied (R-03)
- Control-Tower: lock/unlock + rebaseline sign-off + atomic apply (R-04)
- OpenAPI spec + /llms.txt agent index (R-21, R-22)
- nopm CLI: auth/projects/tasks/audit/report commands (R-23)

## Actual outcomes
- Token management: `POST /api/tokens`, `DELETE /api/tokens/[id]` (revoke); scoped Bearer PAT enforced on all mutation routes
- TOTP: `enroll` / `verify` / `disable` routes via otplib v12 (fixed otplib v13→v12 API)
- Deletion requests: `POST /api/deletion-requests`, `POST .../approve`, `POST .../reject`; DB CHECK `maker_checker_different` prevents self-approval
- Control-Tower: lock/unlock project, create rebaseline, sign-off, atomic apply
- `/api/openapi.json` (33 paths), `/llms.txt` agent discovery index
- `cli/nopm.mjs` with commands: auth, projects, tasks, audit, report
- 8/8 governance smoke tests: self-approval DENIED (403), checker commits (200), task deleted, immutable audit intact
- Fixed: tokens Actor type; CLI help crash on sync command

## R-IDs touched
- R-02 → DONE
- R-03 → DONE
- R-04 → DONE
- R-05 → DONE
- R-21 → DONE
- R-22 → DONE
- R-23 → DONE

## Files
- `web/src/app/api/tokens/route.ts`, `web/src/app/api/tokens/[id]/route.ts`
- `web/src/app/api/auth/mfa/route.ts`, `.../enroll/route.ts`, `.../verify/route.ts`, `.../disable/route.ts`
- `web/src/app/api/deletion-requests/route.ts`, `.../[id]/approve/route.ts`, `.../[id]/reject/route.ts`
- `web/src/app/api/projects/[id]/lock/route.ts`, `.../unlock/route.ts`, `.../rebaselines/route.ts`
- `web/src/app/api/rebaselines/[id]/signoff/route.ts`, `.../apply/route.ts`
- `web/src/app/api/openapi.json/route.ts`, `web/src/app/llms.txt/route.ts`
- `cli/nopm.mjs`, `cli/package.json`
- `web/scripts/smoke-gov.mjs`

## Tests / verification
- `web/scripts/smoke-gov.mjs` — 8/8 green vs live DB

## Follow-ups
- Console UI (W3) deferred to next sprint
