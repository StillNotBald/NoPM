# ADR 0001 — Stack, host, and v1 scope

- **Status:** Accepted
- **Date:** 2026-06-08

## Context
NoPM is a portfolio proof-piece that must be (a) credible as a real PM tool, (b) demonstrably agent-operable, and (c) governance-grade — built fast by reusing three of the author's existing private codebases (a regulated claims platform, a PMO tool, and a console app).

## Decision
- **Stack:** Next.js 16 (App Router) + TypeScript + Tailwind v4 + Supabase (Postgres/Auth/RLS). create-next-app shipped Next **16** (not the planned 15) — accepted because it matches the console app's generation, so the UI port aligns.
- **Host:** **Vercel** (first-party Next.js → most stable) with **Cloudflare** for DNS only. Rejected hosting on Cloudflare Workers/OpenNext: the adapter layer adds instability risk, and for a live employer-facing demo, reliability beats a trendier infra story.
- **Governance in the data layer:** audit immutability enforced by DB triggers; maker-checker four-eyes by a DB CHECK constraint; workspace isolation by RLS — so the guarantees hold even if app code is wrong.
- **Auth:** Supabase session (humans, + TOTP) and scoped Bearer PATs (agents). No OAuth in v1.
- **AI:** none bundled — NoPM is operated by the *user's* agent (the wedge), like aws/supabase/hubspot.

## Consequences
- Deck export must be data-driven (no server DOM) — works on any serverless host.
- Token callers use the service-role admin client (RLS bypassed) → every endpoint must filter by `actor.workspaceId`.
- MCP server is a deferred Phase-1.5 (wraps the same REST + token) — backs the resume's "Playwright + MCP" line.
