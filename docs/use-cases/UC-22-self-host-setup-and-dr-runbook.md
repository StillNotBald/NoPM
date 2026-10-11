# UC-22 · Self-host setup and disaster-recovery runbook (operator use case)

**Goal:** Give an operator who wants to run NoPM against their own infrastructure (rather than the managed Vercel + Supabase + Cloudflare deployment) an honest, documented shape to follow, and give any operator (managed or self-hosted) a drilled procedure for recovering from data loss.

**Actors:** Self-hoster / Operator.

**Preconditions:** None beyond access to the repository; this use case is explicitly **documentation, not shipped code** — a deliberate scope decision dated 2026-08-15 (ADR 0010, "F3 deferral and infra as documentation").

**Trigger:** Someone wants to run NoPM outside the managed stack, or an operator needs to recover from a real incident (or drill for one before it happens).

## Main flow — self-hosting (documented shape only)

1. Today's actual deployment is Vercel (Next.js host) + Supabase-managed (Postgres + Auth + Realtime + RLS) + Cloudflare (DNS). Nothing in this section is required to run the live product.
2. A self-hosted install would need a Supabase-equivalent stack in front of plain Postgres: `web` (this repo's Next.js app) → `kong` (API gateway) → `postgrest` (REST-over-SQL) → `postgres` (the same schema in `web/supabase/migrations/`, applied as-is), plus `gotrue` (Auth) and `realtime` (Postgres logical replication → websocket fan-out for the live bell). `storage` is included in the topology sketch for completeness only — NoPM ships no file-upload feature that depends on it beyond what Documents already uses via Supabase Storage, which is itself part of the same managed/self-hosted Supabase surface.
3. The app code never talks to Postgres directly except through the migration runner (`scripts/migrate.mjs` / `scripts/apply-migrations.mjs`) and ops scripts (seeders, `auth-smoke.mjs`) — every request path goes through `@supabase/ssr`/`@supabase/supabase-js`, so a self-hosted Supabase stack is expected to be a drop-in replacement as far as the app is concerned. **This sketch has not been stood up or verified against a working NoPM deployment** — it is derived from the public self-hosted Supabase reference architecture.
4. Env vars: no new variables beyond `web/.env.example` — self-hosting is a matter of **where the existing variables point** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`, `DB_URL`, `NEXT_PUBLIC_APP_URL`) pointed at your own stack instead of the managed one.
5. Migrations: `DB_URL=postgresql://<user>:<password>@<host>:5432/<db> node scripts/migrate.mjs` — the same script the managed path uses; setting `DB_URL` directly skips the managed-path convenience derivation and applies every migration against any reachable Postgres.

## Main flow — disaster-recovery (PITR) drill

1. Prerequisites: a **scratch** Supabase project, separate from the live `nopm` project — never restore into something you can't afford to overwrite mid-drill.
2. Restore prod → scratch: Supabase dashboard → Settings → Database → Backups → PITR → pick a timestamp → Restore. Confirm the version-skew ordering rule before restoring to a point before the oldest currently-deployed build's migration head.
3. Repoint `.env.local` (or a swapped-in second env file) to the scratch project's values.
4. Verify with `BASE=<scratch-project-app-url> node scripts/auth-smoke.mjs` (from `web/`) — a clean restore prints the same page-count result `auth-smoke` reports against a healthy live target; the current page count is the pass signal, not just "the restore finished."
5. Verify audit-log immutability survived the restore: attempt `update audit_log set action = 'tampered' where id = (select id from audit_log limit 1);` against the restored scratch project. **Expected: the statement fails** ("audit_log is append-only: UPDATE is not permitted"). If it succeeds, the restore is not safe to promote — a blocking finding, not a note.
6. Measure elapsed wall-clock time from the start of the restore click to the finish of a clean `auth-smoke` pass — this is the drill's Recovery Time Objective evidence.
7. Record a dated entry in the Drill log table in `docs/DR_RUNBOOK.md`. A drill without a logged entry is not evidence it happened.

## Alternate and exception flows

- **Free-tier inactivity pause** — a live gotcha, not hypothetical: the Supabase free tier silently pauses a project after inactivity, which has previously taken down the whole live demo without warning (see memory `supabase-pause-demo-outage`). The weekly smoke run doubles as a keep-alive ping. This is a **different** failure mode from data loss — the operator response is to wake the project, not to run a PITR restore.
- **PITR unavailable** — PITR is a paid-tier Supabase feature; a free-tier project only gets daily backups, and only the separate dump/restore drill (`docs/runbooks/backup-restore-drill.md`) is exercisable in that case.
- **Realtime bell degrades under self-hosting** — if the self-hosted `realtime` container's replication-slot/publication configuration doesn't match, the bell does not error, it simply stops receiving live updates and falls back to whatever was last fetched.
- **No self-hosted backup/restore script exists** — this is an honest, stated gap, not a silent one; do not run a self-hosted NoPM against data you cannot afford to lose.
- **No self-hosted RLS/Auth-claim parity check** — nothing in this repo has verified that a self-hosted `gotrue` issues JWTs with the exact claims NoPM's RLS policies expect, byte-for-byte identically to managed Supabase Auth.

## Postconditions

- Self-hosting section: no state change; it is a reference document only.
- DR drill: a dated row in the Drill log table (`docs/DR_RUNBOOK.md`), ideally backed by an evidence folder under `testing-log/`.

## Reporting and evidence

- The Drill log table itself is the evidence artifact for this use case — a drill without a logged entry does not count as having happened, by the runbook's own stated rule.
- `docs/SELF_HOSTING.md` and `docs/DR_RUNBOOK.md` **are** Wave 3's deliverable in its owner-accepted form: infra becomes documentation, not docker-compose code (ADR 0010).

## Traceability

- R-IDs: none formal — this is explicitly the deferred F3 wave, delivered as documentation rather than a numbered, code-backed requirement. See `docs/adr/0010-f3-deferral-and-infra-as-documentation.md`.
- Key files: `docs/SELF_HOSTING.md`, `docs/DR_RUNBOOK.md`, `CUTOVER/01-INSTALL.md` (Self-hosted path STUB), `CUTOVER/04-BACKUP-RESTORE.md` (Self-hosted path STUB), `docs/runbooks/backup-restore-drill.md`, `scripts/migrate.mjs`, `scripts/apply-migrations.mjs`, `web/scripts/auth-smoke.mjs`.
- Tests: none — this use case is procedural/manual by design; `auth-smoke.mjs` is the automated verification step within the procedure, not a test of the procedure itself.

## Outcome note

This use case does not map cleanly onto the three owner-locked scope outcomes (presentable multi-project / easier reporting / frontend flexibility) the way the other 21 do — it is an operational/trust concern for anyone running their own instance, closer in spirit to the governance backbone than to a feature outcome. It is included here because the task briefing named it explicitly as a use case to cover, and because "can I trust this if I run it myself" is a real question a technical evaluator of this codebase would ask.

## Open questions

- `[UNVERIFIED]` Whether any self-hosted deployment of NoPM has ever actually been stood up and verified; the self-hosting document states plainly that it has not.
