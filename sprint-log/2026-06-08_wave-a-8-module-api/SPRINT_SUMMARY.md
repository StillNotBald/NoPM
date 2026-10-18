# Sprint Summary — 2026-06-08_wave-a-8-module-api

**TL;DR:** 8-module REST API end-to-end; Bearer-PAT auth + audit enforced on all routes; smoke suite 8/8 green.

## Declared goals
- Ship all 8 PM domain modules as audited REST endpoints (R-10..R-18)
- Enforce Bearer-PAT scopes and fail-closed audit on every mutation (R-01, R-02, R-20)
- Verify end-to-end against live Supabase DB

## Actual outcomes
- 30+ `route.ts` files across projects, milestones, tasks, risks, issues, clashes, resources, allocations, budget, expenses, time-entries
- Over-allocation detection auto-surfacing resource clash (R-15, R-16)
- `route()` handler wrapper enforcing auth + audit on every mutation
- `{data}/{error}` contract with correct status codes (401/403/404/422)
- 8/8 smoke tests green: 401 no-auth, 403 scope-denial, 201 audited create, 202 maker-checker request
- Fixed: Zod v4 `.issues` break, task NOT-NULL defaults

## R-IDs touched
- R-10 → DONE
- R-11 → DONE
- R-12 → DONE
- R-13 → DONE
- R-14 → DONE
- R-15 → DONE
- R-16 → DONE
- R-17 → DONE
- R-18 → DONE
- R-20 → DONE

## Files
- `web/src/app/api/projects/**`, `milestones/**`, `tasks/**`, `risks/**`, `issues/**`, `clashes/**`, `resources/**`, `allocations/**`, `budget/**`, `expenses/**`, `time-entries/**`
- `web/src/lib/api/handler.ts`, `web/src/lib/api/response.ts`, `web/src/lib/api/errors.ts`
- `web/src/lib/clash/detect.ts`
- `web/scripts/smoke.mjs`

## Tests / verification
- `web/scripts/smoke.mjs` — 8/8 green vs live DB

## Follow-ups
- Governance endpoints (tokens, deletion-requests, rebaselines) deferred to Wave B
