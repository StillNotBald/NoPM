# ADR 0021 - Cloudflare Workers as an alternative host (OpenNext)

- **Status:** Accepted (2026-11-07). Cutover done; Cloudflare Workers is the production host and this supersedes the **host** part of ADR 0001 only (stack, governance and auth in ADR 0001 are unchanged). Cutover log: `docs/ops/CLOUDFLARE_WORKERS.md`.
- **Date:** 2026-11-03
- **Builds on:** ADR 0001 (stack and host), ADR 0011 (security headers and CSP), ADR 0012 (integration hub)
- **Outcome served:** none of the three product outcomes. This is hosting risk and cost, recorded because a host change is an infra decision.

## Context

ADR 0001 chose Vercel because the OpenNext adapter layer added instability risk for a live, employer-facing demo, and rejected Cloudflare Workers. Two things have moved since June:

1. **Vercel Hobby is "non-commercial personal use only".** NoPM is a portfolio proof-piece and a possible SaaS, so the demo sits in a grey zone of that clause. The compliant Vercel option is Pro at USD 20 a month.
2. **The adapter matured.** `@opennextjs/cloudflare` supports Next.js 16 and, since 1.20.3, the Node-runtime `proxy.ts` that NoPM needs (every page request runs it). A build probe on 2026-11-03 with adapter 1.20.15 and wrangler 4.156 built NoPM with no app-code change and bundled the Node middleware (4.99 MiB gzip, under the 10 MiB Workers Paid cap). The same adapter already hosts another production app of the maintainer's.

Workers Paid costs USD 5 a month (10 M requests and 30 M CPU ms included, no egress charge). The Free plan is not usable (10 ms CPU limit breaks server rendering).

## Decision

Prepare, but do not switch, the Cloudflare Workers host:

- Add the OpenNext config, a `wrangler.jsonc`, a custom Worker entry with a `scheduled()` handler for the two cron jobs, and a `_headers` file, all inert on Vercel.
- Trust `CF-Connecting-IP` for the pre-auth client-IP rate limits **only** when `NOPM_TRUST_CF_CONNECTING_IP=1` is set (Cloudflare overwrites that header at its edge). Vercel's logic is unchanged.
- Keep Vercel as the production host. Cutover (DNS) is a separate owner decision after a preview Worker passes the checklist in `docs/ops/CLOUDFLARE_WORKERS.md`.
- Keep Cloudflare DNS, Supabase and the cron route code exactly as they are. The cron routes still verify `Authorization: Bearer $CRON_SECRET`; the Worker supplies it.

## Consequences

- **Cost:** USD 5 a month (Workers Paid) instead of USD 0 (Hobby, grey zone) or USD 20 (Vercel Pro). Cost of the move: about 3 to 4 working days to a tested cutover, most of it testing.
- **Experimental Node middleware (main risk).** Node-runtime middleware in the adapter is labelled experimental, and the OpenNext docs page still says it is not supported. `proxy.ts` runs on every page request and calls Supabase, so a defect would break every page, not one route. Mitigation: a preview Worker on a `workers.dev` URL, with login, MFA redirect and the nonce CSP checked before any DNS change; Vercel stays live throughout.
- **CPU time, not wall time.** PDF and PPTX export (`jspdf`, `pptxgenjs`) are the heaviest routes and must be measured on the preview.
- **`after()` becomes `waitUntil`.** Webhook follow-up work (Telegram, Lark, integration emit) gets about 30 seconds after the response. Failed deliveries are re-queued by the daily cron, so loss is bounded.
- **Region.** Vercel is pinned to `sin1`. Workers run near the caller, so the config sets a placement region of `aws:ap-southeast-1` to run next to Supabase.
- **Builds on Linux only.** A Windows OpenNext build looks alive but fails at runtime. Builds run in WSL or Linux CI.
- **No per-PR previews** (Vercel has them built in). Preview Workers are manual or a CI follow-up.
- **Two hosts to keep working.** The normal `next build` still gates every PR, and `web/vercel.json` is kept for Vercel self-hosters (a test keeps its crons equal to the Worker's). The maintainer no longer has a Vercel project, so the Vercel path is no longer exercised in production; the Cloudflare build is `npm run cf:build`.
- **Docs updated at cutover (2026-11-07):** `docs/ops/PROD_DOOR.md`, `docs/architecture/system_architecture.md`, `docs/SELF_HOSTING.md`.

## Rollback

Superseded 2026-11-07: the owner chose to delete both Vercel projects on 2026-11-07, before the two-week soak and before Telegram/Lark `after()`, the MFA redirect, MCP with a PAT and the first Worker cron run were tested. This is an accepted risk. There is no fallback host: rollback is `wrangler rollback` to an earlier Worker version only (which shares the same runtime), so the plan is fix forward. No data moves (Supabase is the same), so a rollback never touches the database.

Open checks, still untested on Workers (run them against production and record the result in `docs/ops/CLOUDFLARE_WORKERS.md`):

- [ ] Telegram and Lark signed events with the `after()` follow-up (`waitUntil`).
- [ ] The MFA challenge redirect.
- [ ] `/api/mcp` with a PAT.
- [ ] The first real cron run (17:37 UTC on 2026-11-07), both routes returning 200.

## Not decided here

Done on 2026-11-07: the cutover and deleting the Vercel projects. Still open: a CI deploy job (needs its own go-ahead).
