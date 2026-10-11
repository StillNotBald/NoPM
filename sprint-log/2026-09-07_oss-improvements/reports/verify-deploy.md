# Adversarial verification — R-88 one-command self-host (deploy-path.md)

Reviewer: verify-deploy (independent reviewer). Scope: read-only against the working tree,
no writes except this file. Never ran setup/seed/migrate/bootstrap against
the real project; never ran `docker compose config` in non-quiet form.

**Note filed separately with team-lead, not re-litigated here:** the worker's
report discloses that its own `docker compose config` (non-quiet) run printed
live production secrets (SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_PASSWORD,
NOPM_ENCRYPTION_KEY, NOPM_MAKER_TOKEN, NOPM_CHECKER_TOKEN, NOPM_DEMO_LLM_KEY)
into that agent's transcript. Flagged to team-lead directly for owner
rotation action; out of scope for this code-correctness verdict.

## 1. Env-first precedence, no bypass, no secret printing — CONFIRMED

- `web/scripts/lib/env.mjs:55-57` — `loadEnv()` = `{...readEnvLocal(), ...process.env}`,
  so `process.env` always wins (spread order). Missing file tolerated
  (`env.mjs:38-41`, `existsSync` check before read).
- Grepped every tracked script in `web/scripts/*.mjs` for `readFileSync` and
  literal `.env.local` references. Only the four `probe-*.mjs` files still
  hand-parse the file directly — confirmed via `git ls-files | grep probe-`
  (empty) and `git check-ignore -v` (all four match `web/.gitignore:47:
  scripts/probe-*.mjs`) that they are untracked/gitignored, exactly as
  claimed. Every tracked ops script (`bootstrap.mjs`, `setup.mjs`, `seed.mjs`
  and the whole seed chain incl. `seed-approvals.mjs` /
  `seed-sprints-timesheets.mjs` which a shallow head-grep initially missed
  due to long header comments, `apply-migrations.mjs`, `migrate.mjs`,
  `diag.mjs`, `auth-smoke.mjs`, `fix-demo-auth.mjs`, `mcp-smoke.mjs`,
  `mcp-http-smoke.mjs`, `smoke*.mjs`, `verify-journey.mjs`,
  `build-mainline-*.mjs`, `populate-wave-b.mjs`) imports `loadEnv`/`requireEnv`
  from `./lib/env.mjs`.
- No script prints a raw secret value. Grepped every `console.log/error/warn`
  call near secret-shaped variable names — all hits are either variable
  *names* in error/help text (e.g. `mcp-http-smoke.mjs:24`) or values that
  go through `mask()` first (`setup.mjs:110,113,115`). `bootstrap.mjs:56`
  explicitly states "(password from ADMIN_PASSWORD, not printed)" and does
  not print it.

## 2. `setup.mjs --dry-run` network/behavior — CONFIRMED

Ran directly (not simulated):
- `env -i PATH="$PATH" node scripts/setup.mjs --dry-run` (zero injected vars,
  only the repo's real, incomplete `web/.env.local` available via the
  loader): failed with `Missing required environment variables: ADMIN_EMAIL,
  ADMIN_PASSWORD`, exit 1 — plain English, correct, and it resolved
  `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/etc. from the real
  `.env.local` via the merge, proving the fallback path works without any
  network call being reached (the app-required-vars check passed silently;
  only the two setup-only vars failed).
- Same command with a full set of fake env vars, `DB_URL` pointed at
  `postgres://x:y@127.0.0.1:1/z` (unreachable): printed the full masked plan
  (masked keys, masked DB URL, masked admin password) and exited 0 with "No
  database connection was made, no writes occurred." Zero hang, zero
  connection attempt — the `pg.Client` isn't even constructed before the
  `DRY_RUN` early-return at `setup.mjs:125-128`, which is architecturally
  correct (the `--dry-run` check happens before any `run()`/`pg.Client` call
  in the file, not just "usually fast").
- `npm run setup -- --dry-run` from repo root: not independently re-verified
  by me line-for-line, but `package.json:13`
  (`"setup": "npm --prefix web run setup --"`) forwards to `web/package.json`'s
  `"setup": "node scripts/setup.mjs"`, and npm's `--` passthrough is standard;
  no reason to doubt the worker's claim here.

## 3. Idempotency — CONFIRMED with one real gap

- `notify pgrst, 'reload schema'` — CONFIRMED, `setup.mjs:142`, called after
  migrations (step 2) and before bootstrap (step 4), on its own short-lived
  `pg.Client`.
- Migrations: `apply-migrations.mjs:25-34` tracks applied files in
  `_nopm_migrations` and skips (`console.log("skip", f)`) anything already
  recorded — genuinely idempotent.
- Workspace: `bootstrap.mjs:28-31` selects-then-inserts by slug (upsert-like) —
  fine on rerun.
- Admin user: `bootstrap.mjs:38-48` calls `createUser`, and on error (duplicate)
  falls back to `listUsers` + find-by-email — fine on rerun. Profile is a
  true `upsert` (line 49).
- **Gap not mentioned in the report:** `bootstrap.mjs:84` unconditionally
  `appendFileSync`s `NOPM_MAKER_TOKEN` / `NOPM_CHECKER_TOKEN` /
  `NOPM_WORKSPACE_ID` to `web/.env.local` on every run. Two consequences:
  1. **Not truly idempotent as a file artifact** — the file grows by three
     lines every re-run, forever, and old (now-revoked, since lines 59-77
     wipe+re-mint the DB-side tokens on every run) token strings remain
     sitting in the file as stale duplicate `KEY=` lines. `env.mjs`'s parser
     (`env.mjs:20-33`) does `out[key] = val` in file order, so the *last*
     occurrence wins for actual behavior — the app still works — but the
     file is not clean, and a stale duplicate line is a real secret still
     resting in plaintext.
  2. **Still hardcodes a file write in a script whose whole point (per this
     task) is being usable with no file at all.** In a self-host that
     deliberately has no `web/.env.local` (pure env vars, CI, a bare-metal
     install), `bootstrap.mjs` will *create* one at `ENV_LOCAL_PATH`
     (resolved relative to the script's own location, i.e. `web/.env.local`)
     containing live-minted token secrets — surprising side effect for an
     operator who never intended a file-based config, and a plaintext-secret
     file appearing where none existed.
  This is minor (doesn't break setup, doesn't affect the app), but it does
  contradict the "still hardcodes anything?" question in the negative the
  report implicitly gives by not mentioning it. Recommend either gating the
  `appendFileSync` behind an explicit flag/dev-only check, or overwriting a
  dedicated block instead of blind-appending (so reruns don't accumulate
  stale secret lines).

## 4. Docker — CONFIRMED

Built independently: `docker build -t nopm-web-verify ./web` — succeeded in
~35s wall, no `--build-arg`s supplied (placeholder defaults used), no
secrets required at build time.
- **Image size: 306 MB** (`docker images` — exact match to the report).
- `.dockerignore` excludes `.env*` except `.env.example`, and excludes `.git`
  — confirmed no secret file could reach the build context regardless of
  `context: ./web` in `docker-compose.yml`.
- `output: "standalone"` present in `web/next.config.ts` diff (new line,
  4 lines added, nothing else touched).
- Runtime stage copies `public/`, `.next/standalone`, and `.next/static`
  (`Dockerfile:61-63`) — all present; confirmed by actually running the
  container successfully (below).
- Non-root: confirmed live — `docker run --rm nopm-web-verify id` → `uid=1001(nextjs)`.
- `PORT`/`HOSTNAME` env set (`Dockerfile:55-56`), `EXPOSE 3000`, `CMD ["node","server.js"]`.
- `docker compose config --quiet` (never the unredacted form): exit 0, valid.
- Ran the container with fake env: `docker run -d -p 3107:3000 -e NEXT_PUBLIC_SUPABASE_URL=... -e NEXT_PUBLIC_SUPABASE_ANON_KEY=... -e SUPABASE_SERVICE_ROLE_KEY=... -e NOPM_ENCRYPTION_KEY=... nopm-web-verify`
  → `curl /api/health` returned `200 {"data":{"status":"ok","service":"nopm","time":"..."}}`.
  Stopped and removed the container and image afterward.
- Confirmed lazily-read server env by reading source directly:
  `web/src/lib/crypto.ts:17-31` (`loadKey()` throws only when `encrypt`/`decrypt`
  is called) and `web/src/lib/supabase/admin.ts:13-28` (`createAdminClient()`
  throws only when called) — neither throws at import or build time, matching
  the claim that server-only vars don't need to exist at `docker build`.
- Baked-placeholder risk the report flagged is real but correctly mitigated:
  `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` default to `https://placeholder.supabase.co`
  / `placeholder-anon-key` (`Dockerfile:41-42`) if no `--build-arg` is passed —
  a naive `docker build && docker run` with no build-args would ship a client
  bundle pointed at a fake host. This is **documented** prominently in both
  the Dockerfile's own header comment and `docs/SELF_HOSTING.md`'s Docker
  section, which is the correct mitigation for a Next.js constraint (client
  vars must be baked at build time) rather than a code fix — no better fix
  exists without changing how Next.js works.

## 5. Vercel button — CONFIRMED

- `git remote -v` → `origin https://github.com/StillNotBald/NoPM.git` — matches
  the button URL in both `README.md` and `docs/SELF_HOSTING.md`.
- `web/vercel.json` exists (`find` confirmed) — `root-directory=web` in the
  button URL is correct given the Vercel project config lives at `web/`, not
  repo root.
- Grepped `process.env\.` across all of `web/src` (`*.ts`/`*.tsx`): the app's
  own runtime code reads `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `NOPM_ENCRYPTION_KEY` as the security/config-critical
  set — this is exactly the button's `env=` list, no more, no less.
  `NEXT_PUBLIC_APP_URL` does not appear anywhere in that grep — confirmed
  absent from the button's required list, matching the report's own
  reasoning for leaving it out. (Other vars the grep surfaced —
  `DEMO_EMAIL`/`DEMO_PASSWORD`, `NOPM_DEMO_LLM_*`, `NOPM_TOKEN_PREFIX`,
  `NOPM_RATE_*` — are all optional/demo-only, correctly excluded from a
  fresh-install required list.)

## 6. `reseed.yml` — CONFIRMED

Read the full file. The `Reseed demo workspace` step sets
`NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` at step level and runs
`npm run seed:all` as a single shell invocation — that one step's env block
covers the entire chained seed sequence (`seed.mjs` through
`seed-sprints-timesheets.mjs`, per `web/package.json`'s `seed:all` script),
so every script in the chain receives the secrets via `process.env`, which
`loadEnv()` picks up with no file needed. The `Repair demo login` step
separately sets `DEMO_EMAIL`/`DEMO_PASSWORD` (+ the Supabase trio) and calls
`fix-demo-auth.mjs`, which imports `requireEnv` from the shared loader and
exits cleanly with a skip message when `DEMO_EMAIL`/`DEMO_PASSWORD` are
unset — nothing in the file writes or expects `.env.local` any more. Header
comment was updated to match (no longer claims a written file).

## 7. Docs — CONFIRMED, no overclaiming found

Read `docs/SELF_HOSTING.md` and the `docs/guide/02-run-it-yourself.md` diff
in full. Both are honest about scope:
- SELF_HOSTING.md explicitly states "you still need a Supabase project" and
  that a fully local Supabase stack is "out of scope" for the shipped
  compose file, pointing to `npx supabase start` as the alternative — never
  claims to create or host Supabase itself.
- The "Further self-hosting" section is explicitly labeled a documented
  sketch, "not been stood up or verified," with an honest gaps list
  (Realtime bell degrades, no self-hosted backup/restore, no RLS/Auth
  parity check) — consistent with the pre-existing ADR 0010 deferral, not
  newly introduced overclaiming.
- Docker section includes the `docker compose config` non-quiet secret-print
  warning inline for future readers — good, matches the incident learned
  during this same task.
- guide/02 diff correctly frames the two faster paths as optional
  accelerants to the same manual steps, doesn't claim `setup.mjs` does
  anything beyond migrate+bootstrap, and its added precedence note matches
  `env.mjs`'s actual behavior verified in items 1–2 above.

## Test/build verification (re-run independently, not trusted from the report)

- `npx tsc --noEmit` (web/): clean, no output.
- `npx eslint .` (web/): 0 errors, 1 pre-existing warning in
  `src/lib/assistant/providers/openrouter.test.ts:264` (unrelated file) —
  exact match to the report.
- `npx vitest run src/lib/seed/env-loader.test.ts`: 8/8 passing, confirmed
  the mocks genuinely intercept `node:fs` (no real `.env.local` touched).
- `npx vitest run` (full suite): **88 files / 1976 tests, all passing** —
  exact match to the report's claimed count.
- `docker build -t nopm-web-verify ./web`: succeeded, 306 MB image (exact
  match), non-root confirmed live, `/api/health` returned 200 via a
  container run against fully fake env vars. Image and container removed
  after verification.

## Overall verdict: CONFIRMED (worker's report is accurate)

Every one of the 7 assigned items holds up against direct code inspection,
live `--dry-run` runs with real and fake env, an independent Docker build +
run, and full test/typecheck/lint re-runs. No env-precedence bypass, no
secret leaked by any tracked script's own code path, `--dry-run` genuinely
makes zero network calls in both the empty-env and unreachable-host cases,
the PostgREST reload step is present and correctly sequenced, the Docker
image builds/runs/serves `/api/health` as claimed at the exact reported
size, the Vercel button's env list and root-directory are both correct, the
reseed workflow no longer needs or writes a file, and the docs do not
promise anything the code doesn't do.

## Fix list (in priority order)

1. **(New finding, not in the original report)** `web/scripts/bootstrap.mjs:84`
   — stop unconditionally `appendFileSync`-ing minted tokens to
   `web/.env.local` on every run. Either: (a) skip the append entirely when
   the caller supplied `ADMIN_EMAIL`/`ADMIN_PASSWORD`/etc. via real env vars
   rather than a file (i.e., only write the file if `ENV_LOCAL_PATH` already
   existed before this run), or (b) replace the block on rerun instead of
   appending (e.g. strip any prior `NOPM_MAKER_TOKEN=`/`NOPM_CHECKER_TOKEN=`/
   `NOPM_WORKSPACE_ID=` lines before appending the new ones), so reruns don't
   leave stale, still-readable (if since-revoked) secret strings sitting in
   a growing file, and so a pure-env-var self-host doesn't get a surprise
   plaintext-secret file created where none existed.
2. **Not a code fix, but time-sensitive and already flagged to team-lead
   directly:** rotate `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`,
   `NOPM_ENCRYPTION_KEY`, `NOPM_MAKER_TOKEN`, `NOPM_CHECKER_TOKEN` on the live
   Supabase project, and treat `NOPM_DEMO_LLM_KEY` as compromised — these
   were printed in full to a tool-call transcript during this task's own
   verification work (see the worker's report's "Security note" section).
3. No other functional defects found. The repo-visibility caveat the worker
   already raised (Vercel button / `git clone` URL won't resolve for an
   external user until `StillNotBald/NoPM` is flipped public) still stands
   and is correctly called out as a pre-existing, already-known sequencing
   item — not something this task needed to fix.
