# Plan — working demo assistant · friendly onboarding · mobile-usable console

Date: 2026-07-11 · Initiative: three workstreams requested by the owner —
(1) AI assistant must actually work for a visitor (mirror the pattern of a separate reference project's demo site),
(2) onboarding is unfriendly, (3) fully usable on a mobile phone.

Method: an AI-assisted plan-ask-build pipeline — 4 recon agents + synthesis + 4 adversarial critics + 3 completeness rounds
(12 AI agents), every load-bearing claim then grep-verified in a final manual review.

---

## Ground truth (all verified in code, 2026-07-11)

**Assistant (why it doesn't work today)**
- BYOK-only wall: `src/components/assistant/setup.tsx:148` gates the "Try the demo model" button
  on `demoAvailable`, computed from `NOPM_DEMO_LLM_KEY` presence (`credentials/route.ts:24`).
  No `NOPM_DEMO_LLM_*` vars exist in Vercel prod or local `.env.local` → 100% of visitors hit
  a paste-your-own-API-key wall. No mock/grounded fallback exists anywhere in the assistant code.
- `resolveProvider` throws when no key (`src/lib/assistant/index.ts:85-90`) **before**
  `checkDemoRateLimit` (line 92) — any fallback wired at the throw site bypasses the rate limiter.
- Streaming path emits raw `err.message` to the client with no sanitizer (`chat/route.ts:175-177`)
  — upstream provider error bodies (can echo key fragments) would reach the browser.
- Non-streaming path has no try/catch (`chat/route.ts:195`) → sanitized generic 500 in prod.
- Provider union is `openai|anthropic|google` only (`providers/index.ts:13`) — no OpenRouter yet.
- History forwarded unbounded (no slice) — the reference project bounds at 24.
- Persistence only on stream success path; a fallback emitted in the catch would be unaudited.
- **Privacy bug (completeness find):** all demo visitors share one auth user (R-53 demo-login),
  and `conversations/route.ts` + `conversations/[id]/route.ts` scope by `user_id` → every visitor
  can read every prior visitor's chats. Seed never clears `assistant_conversations/messages`.
- Rate limiter RPC is fail-open with no logging (`index.ts:50`); budget (20/hr) is shared-fate
  across all visitors; no per-turn tool-call count cap; provider fetches have no AbortSignal.
- reference-project facts: no `X-Demo-Mode` header exists there (brief was wrong); the portable
  ideas are `writeFallbackTurn` (grounded fallback into the open stream) and `MAX_LLM_HISTORY=24`.

**Onboarding**
- F1: `/case-study` has 3 CTAs, all → `/login` (dead end). Landing already has a working zero-JS
  `DemoLoginButton` (`app/page.tsx:8-19`) but it is file-local/unexported — needs extraction.
- F2: `/login` shows the demo email with no password and no one-click link; wordmark isn't a link.
- F3: seed self-approval bug — `seed.mjs:427-431` sets the pending deletion request's
  `requested_by_id` to the admin (only profile existing at that point in the pipeline), so the
  admin visitor gets `SELF_APPROVAL` 403 on the flagship maker-checker wow moment. Fix must
  RELOCATE the insert to after `seed-members.mjs` (not "just change the id" — no other profile
  exists yet when seed.mjs runs).
- F6/F9: TWO unguarded console pages (`settings/page.tsx`, `tokens/page.tsx`), both client
  components — need a client-safe guard, not the server `redirect()` idiom.
- No `npm run seed` exists (REQUIREMENTS.md R-53 text is stale); real reset = 8 scripts in order.
- No root `error.tsx`/`not-found.tsx` — marketing pages crash to unstyled Next defaults.
- No OpenGraph/Twitter metadata — links shared to employers render no preview card.

**Mobile (390px)**
- Kanban: `grid grid-cols-5` with inert `overflow-x-auto` (1fr tracks never overflow) —
  fix is min-width tracks so scroll engages, gated to preserve desktop (`board.tsx:256`);
  add `touch-none` to TaskCard for dnd-kit touch drag; PointerSensor only — no KeyboardSensor
  (flagship "drag = audited" feature is 100% pointer-only; WCAG 2.1.1).
- Command palette trigger `hidden … sm:flex` — cross-entity search invisible on phones.
- Toaster has no bottom-nav/safe-area offset (pattern exists in `bottom-nav.tsx:166,277`).
- Landing nav: 6 items, no collapse; hero `text-5xl` no downscale.
- Risk heatmap lacks the `overflow-x-auto` wrapper its sibling table has (runtime-verify).
- Already GOOD (verified — don't rebuild): Gantt outer scroll + responsive cols, modal
  bottom-sheet pattern, assistant panel full-width drawer scaffolding (needs iOS keyboard test).
- Gantt has NO drag surface at all — round-1 "Gantt touch-drag gap" was refuted; dropped.
- Theme ground truth: macOS-terminal-light (`globals.css`, `--accent:#00a600`). Constitution's
  cream/coral lines are stale docs from before the owner-requested retheme → correct CLAUDE.md
  in this initiative (same-session, per ask-first hygiene).

---

## Waves

**Wave 1 — Funnel + trust fixes (no migrations)**
1. Extract `DemoLoginButton` → `src/components/demo-login-button.tsx`; use on landing +
   all 3 case-study CTAs + a one-click link on `/login`; wordmark → `<Link href="/">`.
2. F3: remove the deletion-request insert from `seed.mjs`; create it in (or after)
   `seed-members.mjs` with `requested_by_id` = a non-admin profile. Purge
   `assistant_conversations/messages` for the demo user during seed.
3. `npm run seed:all` — one command running the 8 seed scripts in documented order;
   fix R-53 text in REQUIREMENTS.md.
4. Client-safe auth guard applied to `settings/page.tsx` + `tokens/page.tsx`.
5. Root `src/app/error.tsx` (mirror `(console)/error.tsx` styling) + `not-found.tsx` +
   OpenGraph/Twitter metadata in root layout.
6. `.env.example`: document `DEMO_EMAIL/PASSWORD`, `NOPM_ENCRYPTION_KEY`, `NOPM_DEMO_LLM_*`.

**Wave 2 — Assistant that works (the centerpiece)**
1. `openrouter.ts` provider adapter (OpenAI-compatible chat completions; raw fetch, no new lib;
   `HTTP-Referer`/`X-Title` headers; `max_tokens` + bounded history ≤24 like siblings), added to
   the provider union + demo-env dispatch. ADR required.
2. Demo-mode grounded fallback ("assistant always answers"): deterministic intent-matcher over
   2–3 read-only intents (project status, top risks, open approvals) that reuses the SAME
   ephemeral-token mint→call→revoke lifecycle (own mint site — resolveProvider throws before any
   token exists) and persists its reply like a normal turn. Read-only tools ONLY. Gated behind
   `checkDemoRateLimit` regardless of trigger point.
3. Wire fallback at: pre-call (no key), non-streaming catch (new try/catch at chat/route.ts:195),
   and pre-stream failures. Mid-stream deaths AFTER tokens flushed: sanitized `{type:"error"}` +
   retry affordance (no chimera splice).
4. Replace raw `err.message` in the stream catch with a sanitized generic message (never
   upstream text); keep verbose only server-side in dev.
5. Per-turn tool-call cap (e.g. 8) inside the loop; rate-limit RPC failure: log loudly
   (fail-open stays, but observable). AbortSignal timeout on provider fetches.
6. Demo-visitor conversation privacy per D2 (decision below).
7. `X-Demo-Mode` response header on the non-streaming path (streaming already carries
   `usedDemoKey` in the `done` event — headers are sent before the stream resolves).
8. Env wiring: `NOPM_DEMO_LLM_PROVIDER=openrouter`, `NOPM_DEMO_LLM_KEY` (same OpenRouter key as
   the owner's other demo site — owner decision, locked), `NOPM_DEMO_LLM_MODEL` (free tier) — local +
   Vercel prod via printf method. Operational: OpenRouter account has zero credits → free-model
   cap ~50 req/day shared with the owner's other demo site; fallback carries the overflow.
9. Named new tests: `assistant-fallback.test.ts` + `openrouter-provider.test.ts` (+ scopes
   assertions: fallback never gains approve/admin scopes). Suite must GROW from 268.

**Wave 3 — Mobile hardening**
1. Kanban: min-width columns behind the existing overflow (desktop ≥lg keeps current 5-col
   fluid grid); `touch-none` on TaskCard; add KeyboardSensor + an accessible non-drag status
   control path (detail panel select) for WCAG 2.1.1.
2. Palette: mobile-visible trigger (per D9) opening full-screen palette below sm.
3. Toaster: bottom-nav + safe-area offset (reuse existing pattern).
4. Landing: nav collapse to essentials on mobile; hero `text-4xl sm:text-5xl`.
5. Risk heatmap: overflow wrapper (verify at runtime first).
6. Touch-target pass on header + assistant-panel chrome (44px), targeted subset only.
7. Constitution fix: CLAUDE.md theme lines → macOS-terminal-light (supersedes cream/coral).
8. Verification: Playwright 390×844 AND 1366×768 before/after on: shell, registers, Kanban,
   Gantt, forms/modals, palette, assistant panel, landing, case-study. iOS-keyboard check on
   assistant input (dvh).

**Wave 4 — Land**
- Full vitest + tsc + rtm:verify on clean HEAD; auth-smoke.mjs authed page rehearsal;
  deploy `vercel --prod`; live verify on stillnotbald.com (desktop + phone widths);
  RTM/TRACEABILITY same-commit updates; ADR; SPRINT_SUMMARY; lessons→memory.

## R-ID map (updated same commit as code)
- R-24/R-26 (assistant): openrouter adapter, fallback, error sanitization, privacy → update rows.
- R-53 (demo entry): case-study/login CTAs, seed:all, F3 relocation → update row + fix stale text.
- NEW R-ID: mobile usability (Kanban/palette/toast/landing/touch) — add row + paths.
- NEW R-ID (or fold into R-24): demo-mode grounded fallback behavior.
- ADR NNNN: demo assistant provider dispatch (OpenRouter) + grounded-fallback design.

## Risks (carried, mitigations in waves)
- Worst-case spend cannot be bounded in code alone (fail-open limiter + shared budget):
  OpenRouter account holds zero credits by design = a hard spend ceiling; keep it keyless of
  payment methods; revisit only if credits are ever added.
- Prompt injection via shared workspace driving governed writes: fallback is read-only-tools;
  live-LLM path keeps least-privilege scopes + maker-checker on deletes (existing invariants);
  add a system-prompt hardening line (treat tool output as data).
- Mid-stream chimera replies: explicitly avoided (see Wave 2.3).
- Desktop regression from mobile CSS: every fix breakpoint-gated + paired desktop pass.
- Orphaned ephemeral tokens on function timeout: AbortSignal + short provider timeout reduces
  window; token TTL already bounds exposure to 1h; noted as accepted residual.
