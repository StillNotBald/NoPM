# Local-database probes

Scripts that prove the 2026-10-16 migrations and rules hold at the **database**
and **API** layers, run against a **local** Supabase stack (Docker) and a
**local** app — never the live project.

| Probe | Needs | Proves |
|---|---|---|
| `probe-migrations.mjs` | stack | every migration file applied (incl. 0045–0047); the 0046/0047 tables are RLS-on with zero policies and unreadable by `anon` / a signed-in user; replay primitives (one live connector, one link per account and per profile, one inbound action per `(connector, event id)`, unique token hashes) are real constraints |
| `probe-four-eyes.mjs` | stack | principal-aware four-eyes in the database: self-approval refused through any identity of the requester, a null principal never approves, the old RPC overloads are gone, the principal CHECKs and the rebaseline trigger hold, `audit_log` stays append-only and accepts channel `lark`, and each commit RPC has exactly one overload and stamps connector provenance (`via_connector_id`, `external_event_id`, `external_actor_ref`) on both of its audit rows |
| `probe-rls-direct-write.mjs` | stack | signs in as real fixture users with the anon key (like a browser) and attempts direct PostgREST writes that bypass the API (spoof a change-request approval, commit a deletion request, spoof a rebaseline sign-off, delete a risk, update a project, move a task, escalate own role). Verdicts come from the database state, not the HTTP result (an RLS-denied UPDATE/DELETE returns no error). Default: PASS = every write BLOCKED (state after the write policies are dropped); `--expect-open` records today's baseline. Reads, tenant scoping, secret tables and the zero-audit-row finding are checked in both modes |
| `probe-api.mjs` | stack + app | the same rules through the real routes (PAT, session, wildcard scopes, ownerless token), change requests, and the calendar-feed lifecycle |
| `probe-calendar.mjs` | stack + app | the ICS feed end to end: mint (URL shown once, only the hash stored, audit row free of the token), fetch (`text/calendar`, one `VEVENT` per dated milestone of this workspace with the project name resolved, all-day dates, escaping, 75-octet lines), project-scoped feeds, indistinguishable 404s, revoke (owner / admin / teammate rules) |
| `probe-lark.mjs` | stack + app | a fake, correctly signed + AES-256-CBC-encrypted `card.action.trigger` callback: approval committed, audit provenance, replay, requester-self click, wrong recipient, bad signature, kill switch, relay transport; plus the real emit path against `fake-lark` (cards sent to B and admin but not the requester, action token read from the captured card, click commits, the other card is patched to the decided state) |

## The guard (read this)

`guard.mjs` is imported first by every script and **refuses to run (exit 2)**
unless every target is a loopback address:

- the Supabase API URL, the Postgres URL and the app URL must be `127.0.0.1`,
  `localhost` or `::1`;
- the service-role key must not be a hosted-project key (those JWTs carry a
  project `ref`);
- the app-level probes also refuse if `web/.env.local` exists, because
  `next start` would load it for any variable the shell did not set and could
  fall back to the **live** project.

The probes create users, tokens and workspaces and write `audit_log` rows,
which are append-only and cannot be removed. Pointed at a live project that
would be irreversible, hence the paranoia. The scripts deliberately do **not**
read `web/.env.local`; their only inputs are the process environment and an
optional stack file from `supabase status -o env`.

Exit codes: `0` all pass · `1` at least one check FAILED · `2` guard refused ·
`3` the stack or app is not running. There is no "skip" state: a check that
cannot run is a FAIL with the reason, so a green table means every listed rule
was actually exercised.

## One-time setup

Docker Desktop must be running. From `web/`:

```bash
npm ci
# the repo ships supabase/migrations only; the CLI needs a config.toml to start a local stack
npx supabase init          # answer "n" to the editor-settings prompts; do not commit the generated config.toml
```

`supabase init` creates `web/supabase/config.toml`. It is local tooling config,
not part of the product; leave it uncommitted unless the maintainers decide
otherwise.

## Start the stack

```bash
npx supabase start
```

On a fresh stack, `start` applies every file in `supabase/migrations/` in
timestamp order (so 0001 … 0047 run exactly as they would on a new
database). If the stack was started before the newest migrations existed:

```bash
npx supabase migration up          # applies only the pending local migrations
npx supabase db reset              # or: wipe the LOCAL database and replay everything from zero
```

Never use `--linked` / `--db-url` with these commands, and **do not run
`npm run migrate` in this worktree**: it targets whatever `DB_URL` /
`web/.env.local` point at (the hosted project) and connects with SSL, so it is
the wrong tool for a local stack anyway.

## Get the keys into the environment

`supabase status -o env` prints the local API URL and keys. The guard reads
`API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY` and `DB_URL` straight from that
output, through a file:

```bash
# bash
export LOCAL_STACK_ENV="${TMPDIR:-${TEMP:-/tmp}}/nopm-local-stack.env"
npx supabase status -o env > "$LOCAL_STACK_ENV"
```

```powershell
# PowerShell (ascii: the default UTF-16 redirect would not parse)
$env:LOCAL_STACK_ENV = "$env:TEMP\nopm-local-stack.env"
npx supabase status -o env | Out-File -Encoding ascii $env:LOCAL_STACK_ENV
```

Or set the variables yourself:

| Variable | Meaning | Default |
|---|---|---|
| `SUPABASE_URL` (or `API_URL`) | local API URL | from the stack file |
| `SUPABASE_SERVICE_ROLE_KEY` (or `SERVICE_ROLE_KEY`) | service-role key | from the stack file |
| `SUPABASE_ANON_KEY` (or `ANON_KEY`) | anon key (session sign-in, RLS checks) | from the stack file |
| `DB_URL` | direct Postgres URL | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| `APP_URL` | the app under test | `http://localhost:3000` |
| `NOPM_TOKEN_PREFIX` | only if the app overrides the PAT prefix | `npm_` |
| `FAKE_LARK_PORT` | port of `fake-lark` (must match the app's `NOPM_LARK_API_BASE_OVERRIDE`) | `18080` |
| `LOCAL_STACK_ENV` | path of the stack file | none |

`process.env` always wins over the stack file.

## Run order

All from `web/`.

1. **Database probes** (stack only):

   ```bash
   node scripts/local-db/probe-migrations.mjs
   node scripts/local-db/probe-four-eyes.mjs
   ```

2. **Start the app against the local stack** (needed for the next two probes).
   Build first, then start with the outbound-safety proxy variables:

   ```bash
   # bash — values come from the stack file loaded above
   set -a; source "$LOCAL_STACK_ENV"; set +a
   export NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
          NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" \
          SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
          NEXT_PUBLIC_APP_URL=http://localhost:3000 \
          NOPM_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" \
          CRON_SECRET=local-probe-only \
          NOPM_LARK_API_BASE_OVERRIDE=http://127.0.0.1:18080
   npm run build
   # Belt and braces: any HTTP call that is NOT to localhost goes to a dead port,
   # so a bug can never reach a real Lark/Feishu host. (axios, used by the Lark
   # SDK, honours these; the local Supabase calls are exempt via NO_PROXY.)
   HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost \
     npm run start -- -p 3000
   ```

   `NOPM_ENCRYPTION_KEY` is required: connector secrets are encrypted at rest and
   `POST /api/integrations/connectors` answers 503 without it. The probes do not
   need that key themselves.

3. **API probes** (in a second terminal, with `LOCAL_STACK_ENV` exported there too):

   ```bash
   node scripts/local-db/probe-api.mjs
   node scripts/local-db/probe-calendar.mjs
   node scripts/local-db/probe-lark.mjs
   ```

Each run creates its own workspace (`probe-<tag>`) and never reuses another
run's data. Nothing is cleaned up (the audit trail is append-only and blocks
workspace deletion by design); `npx supabase db reset` returns the local
database to a clean slate, and `npx supabase stop` shuts the stack down.

## The Lark probe never calls Lark

Two layers, both loopback only:

- **SQL-seeded checks (`LK-CR*`, `LK-TD*`, `LK-S*`, `LK-I*`, `LK-K1`, `LK-R1`).** Requests are
  seeded straight into the database, so no approval card is queued or sent. The
  seeded delivery rows are `superseded`, which also means deciding a request
  enqueues no card patch. The action tokens are inserted with the documented
  hashing (`npa_` prefix, SHA-256 hex of the raw token, 7-day TTL, recipient-
  and approval-bound).
- **Real emit path (`LK-EM*`) against `fake-lark`.** A raw action token only
  ever exists inside a sent card, so these checks raise requests through the real
  API and let the app send its cards — to `fake-lark.mjs`, a tiny loopback
  server that implements what the SDK client calls (tenant token, bot info,
  send message, patch message) and records every card. The app is pointed at it
  with the test-only `NOPM_LARK_API_BASE_OVERRIDE=http://127.0.0.1:18080`
  (set in the start command above; localhost http URLs only). The probe starts
  `fake-lark` in-process if nothing answers on `FAKE_LARK_PORT` (default 18080);
  to run it yourself: `node scripts/local-db/fake-lark.mjs`. `LK-EM0` proves the
  app is really talking to the fake, and the fake is strict (bearer token
  required, Card JSON 2.0 structure, patch only on `update_multi` cards, unknown
  endpoints recorded) so a mistake in the app shows up here, not on a tenant.
  `LK-N0` finally asserts every `sent` delivery carries a message id the fake
  issued and nothing is stuck in `retry`/`dead`.
- The `HTTPS_PROXY` dead-port setting above is an independent barrier: if the
  override variable were ever missing, the SDK's calls would hit a dead local
  port instead of a real Lark host.

## When a probe fails

- `P0` in `probe-four-eyes.mjs` prints every mismatch between what the probes
  assume and what the schema contains. `contracts.mjs` is the single place those
  names live (principal column names, CHECK names, RPC parameter, errcodes);
  edit it if a migration was named differently.
- The wire details of the Lark callback (header names, signature, encryption,
  toast shape) are in `lark-wire.mjs`, written independently of the app's
  `verify.ts` on purpose so the two implementations check each other.
- A `LK-*2` failure on `task_deletion` while `change_request` passes means the
  audit rows written *inside* the deletion commit RPCs carry channel `lark` but
  no connector / event id (the RPCs have no parameters for them, and
  `audit_log` is append-only, so it cannot be patched afterwards).
