# Sprint Summary — 2026-06-10_backlog-program

**TL;DR:** Cleared the parked backlog in four sequenced, individually-verified multi-agent AI-assisted waves — OpenAPI coverage + drift test, real dependency graph, realtime bell + email previews, assistant streaming/persistence, and a native MCP server — each green (tsc/tests/build) → migrated → deployed → verified live before the next.

## Declared goals
"Do open api and mainline followups and backlog with multi-agent AI assistance" (all three backlog bundles selected: assistant upgrades, MCP server, notifications).

## Waves (each: parallel/sequential AI-agent tracks → verify → commit → migrate → deploy → live-verify)
- **Wave 1 — OpenAPI + Mainline data** (`834c63b`): `openapi.json` now documents every route (+26 path-groups) with a generated **drift test** (107 cases) that fails CI on any undocumented route; `GET /api/timeline` governed portfolio-graph feed + `lib/timeline/gather.ts`; `seed-mainline-deps.mjs` seeded a real per-project FS dependency DAG + `blocked_by` (108 edges, 0 self-loops). Timeline **stagger gated OFF** (conflicts with the completed project's past actuals — deferred to the Mainline-UI wave). Verified live: spec = 58 paths, `/api/timeline` 200 (6 proj / 171 nodes / 16 edges).
- **Wave 2 — Notifications** (`3efd3e9`): Supabase **Realtime** live bell (migration 0024 adds the publication; also fixed a latent bug — the badge read a non-existent `unread_count`); **email demo-previews** (`lib/notify/email.ts` + `/email-previews`, sandboxed iframes, Resend stays demo-mode). Verified live.
- **Wave 3 — Assistant** (`d3246bc`, sequential): conversation **persistence** (migration 0025, deny-all RLS, conversations/[id] routes, panel history); additive **streaming** (provider SSE + `runAssistantStream`; JSON path byte-for-byte preserved; panel falls back on error); **tools↔OpenAPI guard** test (38 cases — drift + least-privilege: TOOL_SCOPES asserted to exclude `task:delete:approve`, `rebaseline:approve`, token scopes, bare/`resource:*` wildcards). The drift test caught the new conversation routes → documented them.
- **Wave 4 — MCP server** (`a414d9b`): `web/mcp/server.mjs` (stdio, `@modelcontextprotocol/sdk`, 15 governed tools via scoped PAT) + README + smoke. **Verified end-to-end**: an MCP client → server → live API returns 15 tools + `list_projects` = 6 projects. ADR 0007.

## R-IDs
- R-21 → upgraded (full coverage + drift test) · R-25 MCP server (DONE) · R-26 assistant streaming + persistence (DONE) · R-27 realtime bell + email previews (DONE) · R-28 Mainline timeline feed + dependency graph (**PARTIAL** — UI parked) · R-60 → 267/267 tests.
- CLAUDE.md updated: MCP server moved out of "ask-first" into Sanctioned; real email **send** stays forbidden (previews only); Mainline UI noted as greenlit-but-parked.

## Verification
- Every wave: `tsc` 0 · vitest (→ 267 passing) · `npm run build` (47+ routes) · migrations 0024+0025 applied to prod · 4 production deploys, each smoke-verified live. RTM OK — 51 R-IDs / 222 paths.
- Caveat: no live LLM key in env, so the assistant *chat* (streaming/persistence) is verified structurally + via its endpoints, not a real LLM turn — exercise once `NOPM_DEMO_LLM_*` is set.

## Follow-ups / still parked
- **Mainline 3-lens UI** (Subway/Journal/Network switcher) — design-approved, feed + data live; build is the remaining piece. The coherent timeline **stagger** belongs to that wave.
- Lower-priority: RLS-for-token-callers, generic after-commit audit atomicity, budget-`actual` consolidation, clash 2-party model, rebaseline quorum.
- User to insert `NOPM_DEMO_LLM_*` on Vercel to light up the live assistant.
