# Run it yourself

This guide gets you a private, working copy of NoPM, connected to your own free database, running on your own machine (and optionally deployed to the web afterwards). It assumes you are comfortable opening a terminal and running commands, but not that you know anything about Supabase or Next.js.

Two quick terms up front:

- **Supabase** is a hosted service that gives you a Postgres database, user login (authentication), and a few other pieces, all pre-wired together. NoPM is built directly on top of it. The free tier is enough to run NoPM.
- **Migration** means "a SQL script that changes your database's structure" (adding a table, a column, and so on). NoPM ships a folder of these and a script that runs them in order.

There are three ways to run NoPM once you have a Supabase project. This guide walks through the manual, step-by-step path, since it explains every piece along the way. If you already understand the pieces and just want the shortest route, see the two faster paths first:

- **A Vercel button plus one command.** Click the deploy button in [`docs/SELF_HOSTING.md`](../SELF_HOSTING.md#fastest-path-vercel-button--npm-run-setup), then run `npm run setup` once from your own machine to set up the database. This does steps 2 through 6 below for you.
- **Docker.** Build and run a container with `docker build` and `docker run`, or `docker compose up`. See the "Docker" section of [`docs/SELF_HOSTING.md`](../SELF_HOSTING.md#docker).

For the deeper, more thorough version, including a topology sketch for replacing Supabase itself with your own infrastructure, which is documented but not something this repository ships a ready-to-run script for, see [`docs/SELF_HOSTING.md`](../SELF_HOSTING.md).

## Prerequisites

- **Node.js 20 or newer** (what the project's CI uses). The `nopm` CLI's own `package.json` declares this minimum explicitly (`"engines": { "node": ">=20" }`); the web app's `package.json` does not declare an `engines` field, but the same minimum applies in practice.
- **A Supabase account** (free tier is enough): [supabase.com](https://supabase.com).
- **Git**, to clone the repository.
- Optionally, a **Vercel account**, if you want to deploy your instance to the public internet instead of just running it on `localhost`.

## Step 1: Clone the repository

```bash
git clone https://github.com/<owner>/NoPM.git
cd NoPM
npm install --prefix web
```

`npm install` also installs the repository's git hooks (a pre-commit check that blocks accidentally committed secrets, and a pre-push check that runs the test suite). You do not need to do anything extra for that; it happens automatically.

## Step 2: Create a Supabase project

1. In the Supabase dashboard, create a new project (any region; pick one close to you).
2. Once it's ready, go to **Project Settings → API** and note down:
   - the **Project URL**
   - the **anon public key**
   - the **service_role key** (this one is powerful, never share it or put it in client-side code)
3. Go to **Project Settings → Database** and note the **database password** you set when creating the project.

## Step 3: Configure your environment

```bash
cd web
cp .env.example .env.local
```

Open `.env.local` and fill in these values (every variable is documented with a comment in the file itself; here is what each group means):

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project's URL from Step 2. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The public key the browser uses to talk to Supabase. Safe to expose to the browser. |
| `SUPABASE_SERVICE_ROLE_KEY` | The powerful server-only key. Never expose this to a browser or commit it anywhere. |
| `SUPABASE_DB_PASSWORD` | The database password from Step 2. |
| `DB_URL` | A full database connection string, used only by the migration script and ops scripts. Built from the values above. |
| `NEXT_PUBLIC_APP_URL` | Where your app will run, for example `http://localhost:3000` for local development. |
| `NOPM_TOKEN_PREFIX` | The prefix put on every access token NoPM mints (default `npm_`). Leave as-is unless you have a reason to change it. |
| `NOPM_ENCRYPTION_KEY` | A 32-byte key (base64-encoded) used to encrypt any BYOK assistant API keys stored at rest. Generate one with `openssl rand -base64 32`. |
| `DEMO_EMAIL` / `DEMO_PASSWORD` | Credentials for a one-click demo login button, if you want one on your own instance. Optional. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Used by `bootstrap.mjs` and the seed/smoke-test scripts to create and sign in as the first admin account. If you leave `ADMIN_EMAIL` unset, the admin account falls back to `admin@stillnotbald.com`. |
| `NOPM_API_URL` / `NOPM_TOKEN` | Used by the CLI and MCP server to know where to send requests and which token to authenticate with. |
| `NOPM_DEMO_LLM_*` | Only relevant if you want to fund a shared AI key for visitors to your instance's built-in assistant, instead of requiring each visitor to paste their own. Leave unset otherwise. |

## Step 4: Set up the database

You can do this one command at a time, or with a single combined command. Both do the same thing.

One command at a time:
```bash
npm run migrate            # applies every SQL file in supabase/migrations/, in order
node scripts/bootstrap.mjs # creates the workspace + the first admin account + demo tokens; required once, before any seeding
```

Or, combined (also sets ADMIN_EMAIL and ADMIN_PASSWORD from your `.env.local` if you added them there):
```bash
node scripts/setup.mjs --dry-run   # optional: prints the plan first, without touching anything
node scripts/setup.mjs             # applies migrations, then bootstraps
```

`bootstrap.mjs` (and `setup.mjs`, which calls it) prints the admin credentials and two scoped tokens to your terminal when it finishes. Save them somewhere safe. This is the only time the tokens are shown in full, and neither script ever prints your `ADMIN_PASSWORD` back to you.

Every ops script in `scripts/` (migrate, bootstrap, setup, seed, smoke tests) reads its environment the same way: a real environment variable always wins, and `web/.env.local` fills in anything not already set. This means the exact same commands work locally with a `.env.local` file, or in a container or CI pipeline where you set environment variables directly and have no file at all.

## Step 5: Optional, load demo data

If you want sample projects, tasks, budgets, and approvals to explore (rather than starting from a completely empty workspace):

```bash
npm run seed:all
```

This is safe to skip. A fresh workspace works fine with nothing in it, and the app's own "first ten minutes" checklist walks you through creating your first project by hand.

## Step 6: Run it

```bash
npm run dev
```

Open `http://localhost:3000`. Log in with the admin credentials `bootstrap.mjs` printed in Step 4.

## Step 7: Mint a token and connect an agent

Once you're logged in as admin, go to **Settings → API Tokens** (`/tokens`) and mint a scoped token the same way described in [01-try-the-demo-with-claude.md](01-try-the-demo-with-claude.md) Step 2. The process is identical on your own instance, just point `NOPM_API_URL` at `http://localhost:3000` instead of the hosted demo when you configure your MCP client.

## Verifying everything works

```bash
npm test                                # unit + governance tests
npx tsc --noEmit                        # typecheck
npm run rtm:verify                      # checks the requirements-to-code map is consistent
node scripts/auth-smoke.mjs             # logs in as admin and loads every page; catches broken pages a build alone would miss
```

## Common mistakes

- **Forgetting to run `bootstrap.mjs` before seeding.** The seed scripts assume a workspace and admin already exist; running them first throws an error on purpose rather than creating a broken, ownerless dataset.
- **Using the anon key where the service-role key belongs, or vice versa.** The service-role key bypasses row-level security (Supabase's per-row access control) and must never reach the browser; the anon key is meant for the browser and cannot bypass anything.
- **Forgetting `DB_URL` before running migrations.** The migration script needs a direct Postgres connection string, not just the Supabase project URL.
- **Deploying to Vercel without setting the same environment variables there.** `.env.local` only affects your local machine. A Vercel deployment needs its own copy of every variable set in the Vercel project settings.
- **Expecting the realtime notification bell to work out of the box on a self-hosted (non-Supabase-managed) Postgres.** If you follow the deeper self-hosting path in `docs/SELF_HOSTING.md` and swap out Supabase's managed services entirely, the live notification bell needs additional replication configuration that this repository does not ship a script for. See that document's "what is not supported" section.

## Where to go deeper

- Vercel button, Docker, and the full self-hosting shape (including replacing managed Supabase with your own infrastructure): [`docs/SELF_HOSTING.md`](../SELF_HOSTING.md)
- Disaster-recovery posture: `docs/DR_RUNBOOK.md`
- Everything the API can do: the live OpenAPI spec at `/api/openapi.json` on your own running instance, or `web/src/app/api/openapi.json`
