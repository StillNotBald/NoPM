# NoPM — Requirements Traceability Matrix (RTM)

Mirror of `REQUIREMENTS.md` (canonical). One row per R-ID → status + the sprint, code, and tests that satisfy it. Update the matching row in the **same commit** as the change. Verify with `npm run rtm:verify`.

| R-ID | Title | Status | Code | Tests |
|------|-------|--------|------|-------|
| R-01 | Immutable audit log | DONE | `web/supabase/migrations/...006_governance.sql`, `web/src/lib/audit/write.ts` | R-60 |
| R-02 | Scoped Bearer PAT | PARTIAL | `web/src/lib/auth/{tokens,guard}.ts`, `...002_identity.sql` | R-60 |
| R-03 | Maker-checker delete-task | PARTIAL | `...006_governance.sql` (CHECK) | R-60 |
| R-04 | Control-Tower rebaseline | PARTIAL | `...006_governance.sql` | — |
| R-05 | Dual auth + TOTP MFA | TODO | — | — |
| R-06 | Workspace RLS isolation | DONE | `web/supabase/migrations/*` | R-60 |
| R-10 | Projects CRUD | TODO | — | — |
| R-11 | Milestones CRUD | TODO | — | — |
| R-12 | Tasks CRUD + typed status | TODO | — | — |
| R-13 | Risk register | TODO | — | — |
| R-14 | Issue register | TODO | — | — |
| R-15 | Clash register | TODO | — | — |
| R-16 | Resource + allocation | TODO | — | — |
| R-17 | Timesheets | TODO | — | — |
| R-18 | Budget | TODO | — | — |
| R-20 | API contract | PARTIAL | `web/src/lib/api/*` | — |
| R-21 | OpenAPI spec | TODO | — | — |
| R-22 | /llms.txt | TODO | — | — |
| R-23 | nopm CLI | TODO | — | — |
| R-30 | RAG dashboard | TODO | — | — |
| R-31 | Registers + inspector | TODO | — | — |
| R-32 | Kanban (audited) | TODO | — | — |
| R-33 | Gantt (lock→rebaseline) | TODO | — | — |
| R-34 | Approvals queue | TODO | — | — |
| R-35 | Trust Center | TODO | — | — |
| R-36 | Token management UI | TODO | — | — |
| R-37 | Notifications | TODO | — | — |
| R-40 | Deck export | TODO | — | — |
| R-50 | Landing + case study | TODO | — | — |
| R-51 | One-pager PDF | TODO | — | — |
| R-52 | Seed script | TODO | — | — |
| R-60 | Unit + invariant tests | TODO | — | — |
| R-61 | Playwright E2E (UAT) | TODO | — | — |
| R-62 | Deploy live | TODO | — | — |
