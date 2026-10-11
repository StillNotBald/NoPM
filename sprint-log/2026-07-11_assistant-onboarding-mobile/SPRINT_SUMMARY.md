# Sprint summary — working demo assistant · friendly onboarding · mobile-usable console

Dates: 2026-07-11 → 2026-07-12 · Method: an AI-assisted plan → ask → build×3 waves → harden → land pipeline
Owner asks: (1) AI assistance must actually work (mirror the demo-site pattern), (2) onboarding
is very unfriendly, (3) fully usable on a mobile phone.

## What shipped (all live on stillnotbald.com)

**Assistant (R-24/R-26, ADR 0008)**
- OpenRouter provider adapter (4th provider; same owner key as the reference demo;
  `nvidia/nemotron-3-super-120b-a12b:free`; zero-credit account = hard spend ceiling;
  ~50 req/day cap SHARED with the reference demo). 45s AbortSignal timeouts on all providers.
- Grounded read-only fallback: when the model is unreachable/capped, a deterministic matcher
  answers from real workspace data via the same ephemeral-token lifecycle, rate-checked first.
- Raw provider error text no longer reaches clients (was streamed verbatim); mid-stream
  failures → sanitized error + Retry in the panel (no chimera replies).
- Demo fresh-chat privacy: shared demo login gets no persistence, empty conversation list,
  404 on history — closes the cross-visitor chat leak. BYOK users unchanged.
- Panel UX: demo model is the primary one-tap option; one-click demo sessions skip the
  setup gate entirely (BYOK wall removed); demo-mode transparency footer.
- Least-privilege mint: viewer-role sessions get read-only ephemeral token scopes.
- Hardening: history bounded (24), per-turn tool-call cap (8), loud logging when the
  rate-limit RPC fails open.
- LIVE E2E PROOF: demo login → chat 200, X-Demo-Mode:true, usedDemoKey:true, real nemotron
  reply grounded in live data; streaming actions/token/done clean; governed WRITE proven —
  the AI resolved UUIDs and created a task; audit row: `task.create` / actor_type `token` /
  "AI Assistant · Demo Visitor".

**Onboarding (R-52/R-53)**
- One-click demo entry on landing, all 3 case-study CTAs, and the login page (extracted
  shared DemoLoginButton; wordmark links home; "or sign in manually" divider).
- Seed integrity: pending deletion request is now raised by Priya Nair (manager) so the
  visitor can actually approve it (was: admin self-approval → guaranteed 403). Demo account
  enforced to MANAGER role by seed-members (was viewer — every write wow-moment 403'd).
- `npm run seed:all` (9 scripts, verified order) + NIGHTLY AUTO-RESET via GitHub Action
  (19:00 UTC = 3am SGT; secrets set; manual dispatch VERIFIED GREEN on 2026-07-11).
- Root error boundary + 404 page (on-brand, recover into the demo funnel), OG/Twitter
  link-preview metadata, `.env.example` documenting all required vars.
- Client-safe auth guards on the two unguarded console pages (settings, tokens).

**Mobile (R-63)**
- Kanban: horizontal-scroll snap strip below lg (min-width columns; desktop grid untouched),
  `touch-none` touch drag, KeyboardSensor + accessible status select in the detail panel
  (WCAG 2.1.1 non-drag path; select respects the timeline lock — review catch).
- Command palette: header search icon below sm; full-screen palette with safe-area padding.
- Toasts clear the bottom nav + iOS safe area; 44px header touch targets below lg.
- Landing/case-study nav collapse + hero downscale at 390px; risk heatmap scrolls in its
  own wrapper. Constitution theme lines corrected (macOS-terminal-light).
- VERIFIED: Playwright 390×844 — zero horizontal page overflow on landing, case-study,
  login, dashboard, project Board tab, risks, review; board strip measured scrollable
  (1541px content in 358px viewport); desktop 1366×768 regression shots clean.

## Commit map (17 commits, 4058b99..HEAD)
Wave 1: 3986e1c demo CTAs · f2c080a seed integrity · ef56e9f auth guards · d5603f5 error/404/meta · 0c7d036 plan docs
Wave 2: 7fe5a63 openrouter · 5c12946 fallback+hardening+privacy · eca355b panel UX · 2fb331d ops/ADR/RTM · 2d5ea75 review fixes (viewer scopes, demo role, requester pin)
Wave 3: a9ccd3d kanban+a11y · 2798667 shell chrome+landing · 70d19ae constitution+R-63 · c8e969a stray tests · (+ reseed Node-22 fix)

## Verification receipts
- vitest 371/371 (was 268 — +103) · tsc clean · rtm:verify 53 R-IDs / 237 paths · lint 0 errors
- Live DB checks: demo profile = manager; pending deletion request by Priya Nair; 0 leftover
  assistant conversations. GH Action reseed run 29159990458: completed/success.
- 12-agent adversarial plan (4 recon + 4 critics + 3 completeness rounds) + per-wave
  3-lens verification on high-risk tasks; every refutation triaged in-session.

## Known debt (logged, deliberate)
- Server-side `PATCH /api/tasks/[id]` does not enforce the timeline lock (pre-existing —
  UI paths all gate on it; a server-side guard is a candidate for the next governance wave).
- Playwright/visual checks are manual passes, not CI gates (R-61 remains the stretch goal).
- Free nemotron sometimes needs explicit "resolve UUIDs first" prompting for multi-step
  writes; system-prompt tuning or a paid model (one env var) would smooth it.
- Cross-model verifier skipped in waves (no OPENROUTER_API_KEY in worker env) — verdicts
  rested on 3 Claude-family lenses.

## Decisions
See DECISIONS.md (12 locked). Owner approvals in-chat: OpenRouter same-key (2026-07-11),
GitHub secrets + live reseed ("yes, pleas do now", 2026-07-12).
