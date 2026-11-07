# Cloudflare Workers host - runbook

**Status: LIVE (2026-11-07).** The Worker `nopm-web` serves https://stillnotbald.com (`docs/ops/PROD_DOOR.md`). This runbook covers building the Worker, testing it on a preview `workers.dev` URL, deploying, and rolling back. Decision record: `docs/adr/0021-cloudflare-workers-host.md` (Accepted).

Nothing here deploys by itself: there is no deploy script in `package.json`. Deploys are owner-run.

## Cutover log 2026-11-07

Done from the Mac (travel mode) between about 08:50 and 08:58 UTC.

- Worker `nopm-web` serves https://stillnotbald.com through a Worker **route** `stillnotbald.com/*` (zone `stillnotbald.com`), not a custom_domain. The apex DNS record is still proxied (orange) and still points at the old Vercel origin; the route intercepts every request. **Owner TODO:** change that record to a placeholder (AAAA `100::`, proxied) so it no longer points at Vercel.
- Final version `b45ed2fb-2691-42c3-a5c2-6c1484ca1582`, built natively on macOS from main `f981344` with `NEXT_PUBLIC_BUILD_SHA=f981344`; `/api/health` reports build `f981344`. Upload 5.10 MiB gzip.
- Crons `7 1 * * *` and `37 17 * * *` are now on the Worker.
- Both Vercel projects (`web`, `your-brand-demo`) were deleted by the owner's choice, so there is no Vercel rollback any more.
- Checked on stillnotbald.com: health, demo login to dashboard, security headers identical to the old Vercel set, 401 on `/api/projects`, `/api/mcp` and the cron route with a wrong secret.
- macOS native OpenNext build worked. npm 11 skipped the install scripts of esbuild and workerd and the build still worked.
- `www.stillnotbald.com` has no DNS record (checked 2026-11-07), so it is not served; the route covers the apex only. Add a route and record if www is ever wanted.
- **Not yet tested on Workers:** Telegram/Lark signed event with `after()`, the MFA redirect, `/api/mcp` with a PAT, and the first real cron run (due 17:37 UTC on 2026-11-07).

## What is in the repo

| File | Purpose |
|---|---|
| `web/open-next.config.ts` | OpenNext config: static-assets incremental cache plus cache interception (without them every prerendered page renders per request) |
| `web/wrangler.jsonc` | Worker `nopm-web`, `nodejs_compat`, placement near Supabase, cron triggers, the production route, non-secret vars. No secrets |
| `web/cloudflare/worker.ts` | Custom entry: OpenNext `fetch` unchanged plus `scheduled()` for the two cron jobs |
| `web/src/lib/host/cloudflare-cron.ts` | Expression to route mapping used by `scheduled()` (tested) |
| `web/public/_headers` | `/_next/static/*` served `public, max-age=31536000, immutable` |
| `NOPM_TRUST_CF_CONNECTING_IP=1` (var) | Lets the pre-auth IP rate limits read `CF-Connecting-IP` (`web/src/lib/api/client-ip.ts`) |

A Vercel self-host ignores `wrangler.jsonc`, `open-next.config.ts` and `cloudflare/`. `public/_headers` is a Netlify/Cloudflare format that Vercel does not act on.

## Rules

1. **Build on macOS or Linux/WSL only.** A native macOS build is OK (proven 2026-11-07). An OpenNext bundle built on Windows looks half alive and then fails on every server route at runtime ("Dynamic require of ... middleware-manifest.json"). Never deploy a Windows-built `.open-next`.
2. Node 24 (repo pin). A wrong Node gives false failures.
3. **Secrets never go in a file, a commit, a log or a chat.** Use `wrangler secret put` or `wrangler secret bulk` (below). Never echo a value.
4. Before a WSL build, check there is room: `wsl.exe -e free -m` (aim for 6 GB or more free) and Windows commit memory. A WSL restart in the middle of `npm ci` leaves empty `node_modules/.bin` shims and the build then "succeeds" with no output (see step 3).

## 1. Copy the app to the Linux filesystem

From WSL (not from `/mnt/c`, which is slow and breaks symlinks):

```bash
rsync -a --delete --exclude node_modules --exclude .next --exclude .open-next \
  --exclude .wrangler --exclude '.env*' --exclude .git \
  "/mnt/c/<path-to-repo>/web/" ~/nopm-cf-build/
cd ~/nopm-cf-build && source ~/.nvm/nvm.sh && npm ci
```

From Git Bash on Windows, wrap it as `wsl.exe -e bash -c '...'` (bare `/mnt/c/...` arguments get mangled).

## 2. Build

`NEXT_PUBLIC_*` values are inlined at build time, so set them for the build (public values only):

```bash
NEXT_PUBLIC_BUILD_SHA=<short-git-sha> \
NEXT_PUBLIC_APP_URL=https://<the-hostname-being-tested> \
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key> \
npm run cf:build
```

The rsync drops `.git`, so pass `NEXT_PUBLIC_BUILD_SHA` or `/api/health` reports build `unknown`.

## 3. Verify the build really produced a Worker

```bash
ls -la .open-next/worker.js          # must exist and be large
find node_modules -path "*/.bin/*" -size 0 | wc -l    # must be 0
```

If `worker.js` is missing, the build exited quietly: re-run `npm ci --force` and build again. Do not continue without the file.

Size check (no upload):

```bash
npx wrangler deploy --dry-run --outdir /tmp/nopm-dry
```

Workers Paid allows 10 MiB compressed (the Free 3 MiB limit is too small). The 2026-11-03 probe was 4.99 MiB gzip.

## 4. Secrets (preview Worker)

Use the names in `web/.env.example`; the server-side set is at least `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_*` (also available at runtime), `CRON_SECRET`, and the assistant, Lark and Telegram secrets you use. Non-secret values (`NOPM_TRUST_CF_CONNECTING_IP`, `NEXT_PUBLIC_APP_URL`) are already `vars` in `wrangler.jsonc`.

Authenticate in the shell where you deploy, with `wrangler login` run by the owner there. **Never copy Windows wrangler credentials into WSL.** Then, one at a time, typing the value at the prompt:

```bash
npx wrangler secret put CRON_SECRET
```

Or many at once from a file that lives outside the repo and is deleted afterwards:

```bash
npx wrangler secret bulk /path/outside/repo/secrets.json
```

Generate `CRON_SECRET` as at least 32 random characters. The routes refuse every call when it is unset.

## 5. Preview Worker test (no DNS)

**A bare `npx wrangler deploy` is a production deploy:** `routes` is in `wrangler.jsonc`, so it replaces the live version on stillnotbald.com. To test first, run `npm run cf:preview` locally, then `npx wrangler versions upload --var NEXT_PUBLIC_BUILD_SHA:<sha>` (owner-approved). That uploads a version with its own preview URL and shifts no traffic; the checklist runs against that URL. Promote with `npx wrangler versions deploy` (step 6). Point the preview at the same Supabase and set `NEXT_PUBLIC_APP_URL` to the preview URL for the test.

Checklist, in this order (stop at the first failure):

- [ ] `/api/health` returns 200 and `build` equals the SHA you passed.
- [ ] **Login**, then an MFA challenge redirect (`proxy.ts` runs on the Node middleware path; this is the experimental part). A page that renders once logged in proves Supabase session refresh works.
- [ ] **CSP nonce:** response headers carry a `Content-Security-Policy` with a nonce and no `unsafe-inline`, and `x-nonce` matches the page's scripts. Compare all security headers with production (ADR 0011).
- [ ] **Assistant streaming:** a chat reply arrives progressively, not all at once (the stream is not buffered).
- [ ] **`/api/mcp`:** initialize and `tools/list` with a PAT. Needs `NEXT_PUBLIC_APP_URL` set in production mode.
- [ ] **PDF and PPTX export:** run both on a real project; record CPU time in Workers Logs. Any error 1102 means the CPU limit was hit (Workers Paid is required; redeploy after a plan change before judging).
- [ ] **Telegram and Lark webhooks:** a signed test event is accepted and its `after()` follow-up (mapped to `waitUntil`, about 30 seconds) completes, including with a deliberately slow connector. A failed item must be re-queued by the daily cron.
- [ ] **Cron:** trigger each cron once (`npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=7+1+*+*+*"`, or the dashboard "Trigger" button) and confirm `/api/integrations/cron` and `/api/cron/snapshots` return 200 in Workers Logs. A wrong secret shows 401.
- [ ] **Client IP:** a request through Cloudflare is rate-limited by its real address (invite-accept bucket differs per caller), and a forged `X-Forwarded-For` does not change the bucket.
- [ ] **Static caching:** the second fetch of a `/_next/static/*` chunk returns `CF-Cache-Status: HIT` and `immutable`.
- [ ] TTFB from Kuala Lumpur and Singapore against the previous release; a prerendered page shows `x-opennext-cache: HIT`.

Log of the result goes in a sprint log, with the numbers.

## 6. Deploy to production (owner-run)

1. Build from the approved commit with `NEXT_PUBLIC_BUILD_SHA=<sha>` set (step 2).
2. Deploy with the build SHA as a runtime var so `/api/health` reports it: `npx wrangler deploy --var NEXT_PUBLIC_BUILD_SHA:<sha>` (goes straight to production), or, after a preview upload (step 5), promote that version with `npx wrangler versions deploy`. Do not put the SHA in `wrangler.jsonc`.
3. Check `/api/health`, a demo login, and the security headers on https://stillnotbald.com.
4. Telegram and Lark webhook URLs stay valid because the hostname does not change.

## 7. Rollback

1. Fix forward, or redeploy a previous Worker version: `npx wrangler rollback` (pick the version from `npx wrangler deployments list`). Vercel is gone (both projects deleted 2026-11-07), so there is no DNS fallback.
2. If a cron misbehaves, remove `triggers.crons` and redeploy, or detach the schedule in the dashboard.
3. No data to move: Supabase is the database either way.

## Known risks

- Node-runtime middleware (`proxy.ts`) is experimental in the adapter. It runs on every page request.
- `jspdf`, `pptxgenjs` and `@larksuiteoapi/node-sdk` are large; the PDF and PPTX routes need a measured CPU time.
- The optional audit anchor (`pg` over TCP, `NOPM_ANCHOR_DB_URL`) is untested on Workers; leave it unset on the first preview.
- The Open Graph cards read font files from disk. They are generated at build and served as static files, so this does not run per request (checked in the PR that added this runbook).
