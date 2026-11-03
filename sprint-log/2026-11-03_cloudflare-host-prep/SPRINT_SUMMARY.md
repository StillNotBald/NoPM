# Sprint summary: Cloudflare Workers host prep

Date: 2026-11-03. Branch `feat/cloudflare-host-prep`. ADR 0021 (Proposed). Requirement: R-205.

**TL;DR:** Everything needed to run NoPM on Cloudflare Workers via OpenNext is in the repo and off by default. Vercel is still the host and behaves exactly as before. No deploy, no DNS change, no Cloudflare account action.

## Declared goals
- ADR 0021, runbook `docs/ops/CLOUDFLARE_WORKERS.md`, R-205 plus its RTM row.
- Client-address trust for `CF-Connecting-IP` behind `NOPM_TRUST_CF_CONNECTING_IP=1`.
- OpenNext config, `wrangler.jsonc`, custom Worker entry with `scheduled()`, `_headers`.
- Pinned dev dependencies and `cf:build` / `cf:preview` scripts (no deploy script).
- A build proof in WSL (no deploy).

## Actual outcomes
- `client-ip.ts`: new branch after the Vercel branch; the header is read only when the flag is exactly `1`, and then nothing else is read as a fallback. 5 new tests (flag off or not 1, flag on, invalid and multi-value rejected, IPv6 /64 key, Vercel path unchanged even with the flag set).
- `src/lib/host/cloudflare-cron.ts`: pure expression to route mapping and the in-process call with `Authorization: Bearer $CRON_SECRET`; `cloudflare/worker.ts` wires it. Tests pin both expressions to `vercel.json` and `wrangler.jsonc`, the unknown-expression no-op, and that the secret is never logged. The cron routes are not changed.
- Pinned `@opennextjs/cloudflare` 1.20.15 and `wrangler` 4.156.0 as devDependencies (the probe versions). Lockfile: 257 packages added, none of the existing ones changed version.
- `.open-next/` and `.wrangler/` are excluded from tsconfig, eslint, git and Docker context.
- Checked, no code change needed: `/api/health` build SHA falls back to `NEXT_PUBLIC_BUILD_SHA`; the Lark card base URL falls back to `NEXT_PUBLIC_APP_URL` (set as a Worker var); the Open Graph cards are prerendered at build.

## Defaults chosen
- Cron is dispatched in-process to the OpenNext handler (no network hop, works before DNS), not by fetching the public URL.
- Placement uses `{ mode: "targeted", region: "aws:ap-southeast-1" }` (the key in the installed wrangler schema).
- `NEXT_PUBLIC_APP_URL` is a non-secret `var` set to the production URL; the preview test overrides it.

## R-IDs touched
- R-205 -> DONE (host support exists and is inert; the host switch itself is not done).

## Not done
- No deploy, no `wrangler login`, no DNS, no custom domain, no secrets set.
- Runtime is unproven: login, MFA redirect, CSP nonce, streaming, PDF/PPTX CPU time and webhook `waitUntil` still need the preview-Worker test in the runbook.
- No CI job for the Cloudflare build.
