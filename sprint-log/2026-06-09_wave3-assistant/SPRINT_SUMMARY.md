# Sprint — Wave 3: BYOK governed AI assistant (2026-06-09)

**Intent:** ship the thesis centerpiece — the user's own LLM operates NoPM through its REST API under scopes + audit + maker-checker. A bolted-on chatbot would undercut the "no bundled LLM" wedge; a *governed agent client* showcases it. Built by three AI implementation agents (foundation · engine · UI) on disjoint files + a verify pass, then integrated by hand.

## Done
- **Encryption + credential vault (foundation):** `src/lib/crypto.ts` — AES-256-GCM (key from `NOPM_ENCRYPTION_KEY`, checked inside the functions so `next build` survives its absence). Migration `0014_assistant_credentials` — RLS enabled, **zero policies (deny-all)**, admin-client-only, `unique(user_id)`. `api/assistant/credentials` GET/PUT/DELETE — session-user only (token actors 403), **never returns the key**, `demoAvailable` derived from server env.
- **Provider adapters + governed engine (engine):** `lib/assistant/providers/{openai,anthropic,google,index}` — raw `fetch`, **no new deps**, normalized to one `chat()` shape. `tools.ts` — 15 curated tools mapped 1:1 to **real** endpoints (verified against the live `src/app/api` tree). `token.ts` — mints a **real ephemeral `api_tokens` row** (`AI Assistant · <user>`, 1h TTL, revoked in `finally`); `TOOL_SCOPES` = read+write across project/milestone/task/risk/issue/budget/clash/resource/audit **+ `task:delete:request`**, **excluding** `task:delete:approve`, `token:*`, mfa. `index.ts` — agentic loop (≤6 steps) executes tool calls by calling **NoPM's own API over HTTP** with the Bearer token → audited as a token actor; deletes bounce to maker-checker. `api/assistant/chat` — session-only, validates body, passes `origin`.
- **Tokens list hardening (engine):** `api/tokens` GET now excludes `AI Assistant ·%` rows from both count and list — ephemeral tokens stay out of the human governance UI while remaining real/revocable.
- **UI (ui):** `components/assistant/{panel,setup}` — Sparkles trigger in the header (before the bell) → right slide-over (full-screen sheet on mobile); first-run setup (provider → key → model, or "try the demo model"); chat transcript with **governed-action chips** + footer showing active model / demo-key state. Mounted in `app-shell.tsx`.

## Verification
- `tsc --noEmit` clean · `next build` clean (all three assistant routes present) · migration `0014` applied to prod DB.
- Deployed **READY** → stillnotbald.com. Live probes: `/api/health` 200; `GET /api/assistant/credentials` and `POST /api/assistant/chat` both **401 unauthenticated** (session guard live).
- `NOPM_ENCRYPTION_KEY` set in `.env.local` + Vercel (production + development).
- RTM reconciled green: **35 R-IDs / 118 paths** (`npm run rtm:verify`). Added **R-24** (governed assistant); corrected stale rows **R-37** notifications → DONE, **R-60** tests → DONE (34/34), **R-62** deploy → DONE.
- ADR **0004-byok-governed-assistant** records the BYOK-not-subscription decision + the governance framing.

## Open / deferred
- **Full chat demo needs an LLM key** — a real BYOK key (employer's own) or an owner-funded demo key (`NOPM_DEMO_LLM_*`, not yet set). Plumbing + UI + guards are verified without one; the model round-trip is the only unexercised path. Remaining: an owner-funded demo key must be configured so an anonymous visitor can try the assistant without their own key.
- Action chips don't yet deep-link to the specific `audit_log` row (envelope has no `auditId`); non-streaming; no cross-session history; in-memory demo rate-limit. All deferred.

## Next
- Wave 4: predecessor-platform reuse — review queue + document folder viewer.
