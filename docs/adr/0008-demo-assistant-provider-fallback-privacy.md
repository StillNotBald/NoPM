# ADR 0008 — Demo assistant: OpenRouter provider dispatch, grounded fallback, demo-session privacy

- **Status:** Accepted
- **Date:** 2026-07-11

## Context

The BYOK governed assistant (ADR 0004) and its streaming/persistence layer (R-26) work well for a signed-up user who pastes their own API key. The public, cold-visitor "Try the live demo" flow (R-53) is a different situation with three open problems:

1. **Demo funding flexibility.** The owner-funded demo key (`NOPM_DEMO_LLM_*`, server-only, rate-limited) previously had to be an OpenAI, Anthropic, or Google key. Those providers are billed per-token with no meaningful free tier, which makes an always-on public demo expensive to keep funded and exposes the owner to unbounded cost if the rate limiter is ever bypassed.
2. **No answer when the demo key is unfunded or exhausted.** Before this key is provisioned — or once its rate limit trips, or the upstream provider has a transient outage — the assistant had nothing to fall back to except a raw error, which is a poor first impression for an unauthenticated visitor evaluating the product.
3. **Cross-visitor chat leakage on a shared login.** The demo account is one real Supabase Auth session shared by every visitor (`DEMO_EMAIL`/`DEMO_PASSWORD`). Saved-conversation persistence, designed for a single real user, would let one visitor's chat history — and the read-only workspace data referenced in it — surface to the next visitor who happens to land on the same seeded login.

This ADR covers the fix for all three, plus the reseed automation that keeps the demo workspace itself clean, which shares the "keep the public demo trustworthy and cheap" motivation.

## Decision

### 1. OpenRouter as a fourth, env-selected provider

`openrouter` joins `openai` / `anthropic` / `google` as a fourth value of the assistant's `Provider` type (`web/src/lib/assistant/providers/openrouter.ts`, routed through `web/src/lib/assistant/providers/index.ts`). It talks to OpenRouter's OpenAI-schema-compatible `/chat/completions` endpoint over raw `fetch` — no new npm dependency. The owner selects it for the demo key by setting `NOPM_DEMO_LLM_PROVIDER=openrouter` (server-only env, set **after** this change ships — never a value committed to code or docs) and pointing `NOPM_DEMO_LLM_MODEL` at a free OpenRouter model id, which lets the public demo run on a $0-marginal-cost model instead of a metered one.

This does **not** loosen the constitution's "no bundled LLM" rule: OpenRouter is reachable exactly like the other three providers — as a BYOK option (a visitor may paste their own OpenRouter key) or as the owner-funded, rate-limited demo key. NoPM still ships no model and no key of its own.

### 2. Deterministic, grounded, read-only fallback

When the real provider call fails for any reason — no BYOK credentials configured, the demo key unfunded or exhausted, an upstream rate-limit/capacity error, a transient network failure — `web/src/lib/assistant/fallback.ts` answers instead of surfacing the failure. It never calls a provider. It matches the message against a small set of deterministic intents (portfolio status, open risks, recent activity, a default summary) and composes the reply strictly from real data returned by a fixed allowlist of **read-only** tools (derived from the tool registry itself — every `ToolSpec` whose request builds a GET, so a write tool can never end up in the allowlist by accident).

Governance stays intact on this path:
- the fallback calls the caller's **existing rate-limit check first**, before minting a token or touching any tool — it can never be used to bypass the demo rate limiter;
- it mints and revokes its **own ephemeral scoped token**, the same lifecycle the real agentic loop uses, so every read it performs is an audited token-actor call like any other;
- it never invents numbers — every figure in its reply traces back to a real API response.

Streaming and non-streaming both route through it identically. Per the streaming protocol's backward-compatibility rule, the outcome is carried as an **additive** `usedFallback` field on the `done` event — existing clients that only read `usedDemoKey` are unaffected. A mid-stream failure that happens *after* tokens have already been flushed to the client is never patched with fallback text; the client gets a sanitized `{type:'error'}` event and shows its retry affordance, so a reply is never a silent stitch of two different sources. `X-Demo-Mode` is set to `true` whenever either the demo key or the fallback produced the reply, but only on the non-streaming response — the streaming path already carries the equivalent signal (`usedDemoKey` / `usedFallback`) in its `done` event.

No raw upstream or provider error text ever reaches the client on either path — every error surface is a fixed, sanitized message.

### 3. Demo-session privacy: fresh chat every visit

`web/src/lib/auth/demo.ts` resolves whether the current session actor *is* the shared demo login by comparing the session's profile email against `DEMO_EMAIL` (a real Supabase Auth session has no field that otherwise distinguishes it from a genuine signed-up user). Token/PAT actors are never the demo identity by construction and short-circuit without a database round-trip.

For a demo actor, the chat route (`web/src/app/api/assistant/chat/route.ts`) and the conversations endpoints never create, load, list, or persist a conversation: `conversation_id` is always `null` in the response, no `assistant_conversations`/`assistant_messages` rows are written, and listing/reading a specific conversation is rejected outright. Every visitor gets a clean slate; nothing from a prior visitor's session is ever reachable. BYOK/non-demo users are completely unaffected — this check is additive and only short-circuits the demo identity's own persistence. No database migration was needed or made — the guard is entirely in application code, keyed off the existing seeded demo profile.

The nightly reseed (below) closes the matching server-side gap: even without this guard, a stale `assistant_conversations` row from a *previous night's* demo traffic would otherwise persist across the reseed cycle until `seed.mjs` explicitly purges it.

### 4. Nightly demo reseed automation

`.github/workflows/reseed.yml` runs `npm run seed:all` on a schedule (19:00 UTC daily — 03:00 Asia/Singapore, chosen for low traffic) plus `workflow_dispatch` for a manual run. It installs dependencies, then runs the same seed-script chain a human would run locally. Because every script in that chain reads its Supabase credentials from `web/.env.local` via `readFileSync` rather than `process.env`, the workflow writes the two required secrets into a fresh `.env.local` inside the ephemeral runner immediately before seeding; that file is never committed and never printed. The job fails loud on any error (no `continue-on-error`) and the two required secret names are documented in a comment at the top of the workflow file rather than being set by this change — the workflow will fail until the repository owner adds `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as GitHub Actions secrets, which is an accepted, expected state until that happens.

## Consequences

- The public demo can run indefinitely on a free-tier model without metered cost exposure, while still degrading gracefully (never a raw error) if that model or the whole provider is unavailable.
- The assistant's failure mode changed from "surface an error" to "answer from real, read-only data, clearly marked as limited" — a stronger demo experience with no new governance surface: the fallback reuses the same rate limiter and the same ephemeral-token/audit chokepoint as every other assistant call.
- Demo-session privacy is a pure application-layer guard with no schema change — cheap to reason about, but it is keyed on `DEMO_EMAIL` matching the seeded profile's email; if a deployment's demo profile email and the `DEMO_EMAIL` env var ever drift apart, the guard silently stops recognizing the demo actor (fails open to "treat as a normal user," not fails closed) and should be checked whenever the demo account is reseeded or re-provisioned.
- The reseed workflow is inert until the owner adds the two GitHub Actions secrets — an intentional, visible gap rather than a silent one (the job fails with a clear "secret not set" style error rather than running against no credentials).
- Streaming stays byte-for-byte backward compatible: `usedFallback` is additive, `usedDemoKey` keeps its original meaning, and no existing NDJSON event type changed shape.
