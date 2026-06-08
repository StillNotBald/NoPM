# ADR 0004 — BYOK governed assistant (no bundled LLM, no subscription OAuth)

- **Status:** Accepted
- **Date:** 2026-06-09

## Context

The product wants an in-app AI assistant. The user's stated expectation was "let me log in with my Gemini / Claude / ChatGPT account, like Claude in Chrome." Two hard constraints shape the design:

1. **The constitution forbids a bundled LLM.** NoPM's wedge is "an API-first PM tool that *the user's own* agent operates" — like the `aws` / `supabase` CLIs. Shipping a model or a model key inside NoPM would undercut that wedge.
2. **Consumer subscriptions cannot be resold.** There is no OAuth that bills model calls to someone's ChatGPT Plus / Claude Pro / Gemini Advanced *subscription*. "Claude in Chrome" works only because it is Anthropic's own extension riding the user's `claude.ai` browser session. The supported equivalent for a third-party app is **BYOK** — a developer API key from the provider's console, billed to the user's own API account.

## Decision

Build the assistant as a **governed agent client**, not a bolted-on chatbot:

- **BYOK** — the user pastes an OpenAI / Anthropic / Google **developer API key**. It is encrypted with **AES-256-GCM** (`web/src/lib/crypto.ts`, key from env `NOPM_ENCRYPTION_KEY`) and stored in `assistant_credentials`, a table with **RLS enabled and zero policies** (deny-all; only the service-role admin client touches it). The key is never returned to the client and never logged. An optional owner-funded **demo key** (`NOPM_DEMO_LLM_*`, server-only env, rate-limited) lets an anonymous employer try it.
- **The model drives NoPM's own REST API as tools.** The assistant does not get a privileged code path. Per chat turn the server mints a **real, ephemeral, scoped `api_tokens` row** (`AI Assistant · <user>`, 1-hour TTL, revoked in a `finally`), then executes the model's tool calls by calling NoPM's own HTTP API with that Bearer token. Therefore:
  - every create/update is **audited as a `token` actor** (one immutable `audit_log` row, same chokepoint as any other caller);
  - the token's scopes deliberately include read+write across the PM modules **and `task:delete:request`**, but **exclude** `task:delete:approve`, `token:*`, and any MFA scope — so the assistant can *request* a deletion but a **human must approve** it (maker-checker), and that request raises a bell notification.
- **Ephemeral tokens are hidden from the human Tokens list** via a name filter (`AI Assistant ·%`) so they don't clutter governance UI, while still being real, revocable, expiring rows in the same table.

## Consequences

- The assistant is itself a **live demo of the core thesis**: "your own AI agent operates NoPM, under governance" — scopes, audit, and maker-checker are exercised by the feature, not bypassed by it.
- The constitution's "no bundled LLM" rule still holds: NoPM ships **no model and no key**. `CLAUDE.md` records this sanction.
- **Cost is the user's**, on their own API account (or the owner demo key, rate-limited). No silent third-party billing.
- Limitations accepted for v1: non-streaming responses; conversation not persisted across sessions; the demo rate-limit is in-memory (resets on instance restart); action chips link to the created entity but not yet to the specific `audit_log` row (the API envelope returns `{data}` without an `auditId`). All deferred, not blocking.
- A new secret (`NOPM_ENCRYPTION_KEY`) is now load-bearing: set in `.env.local` and in Vercel (production + development). Losing/rotating it invalidates stored BYOK keys (users re-enter them) — acceptable, since keys are user-replaceable and never the source of truth.
