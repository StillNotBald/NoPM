# Sprint Summary — 2026-08-24_mcp-http-connector-landing-polish

**TL;DR:** NoPM is now reachable as a remote claude.ai Connector (not just local Claude Desktop/Code), verified live end-to-end with a real claude.ai session; landing page copy/layout de-genericized; investor demo guide published.

## Declared goals
- Extend R-25 (Native MCP server) with a remote transport so NoPM can be added as a `claude.ai` custom connector, not just a local stdio process.
- Fix the landing page (`web/src/app/page.tsx`) — flagged as reading like generic AI-slop, both design and copy.

## Actual outcomes

**MCP remote HTTP transport (R-25 extension)**
- New `web/src/app/api/mcp/route.ts` — Streamable HTTP MCP transport (`@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport`), stateless per-request, reusing the same `web/mcp/tools.mjs` `TOOL_REGISTRY` the stdio server and the in-app BYOK assistant already share. No baked-in credential — each request's own `Authorization: Bearer npm_...` is forwarded verbatim to this same origin's REST API, so scopes/audit/maker-checker are unchanged. Missing header → 401 before any tool logic runs; a present-but-bad token flows through to a normal `{ error }` tool result exactly like the stdio server.
- New `web/scripts/mcp-http-smoke.mjs` — verifies `initialize` → `tools/list` (24 tools) → `tools/call list_projects` → unauthenticated request 401s.
- Docs: `web/mcp/README.md` (claude.ai Connector setup section), `docs/adr/0007-mcp-server.md` (dated update entry), `requirements/REQUIREMENTS.md` + `TRACEABILITY.md` (R-25 row extended to both transports, same commit).
- **Verified live**: minted a real PAT in the production app, added `https://stillnotbald.com/api/mcp` as a custom connector in claude.ai (Authentication: None + a request header `authorization: Bearer <token>` — claude.ai's "None" option is for API-key-style auth, not literally unauthenticated), asked claude.ai in chat to "list my NoPM projects" — it called the tool, hit the approval prompt, and returned real portfolio data with a genuine cross-project dependency read (two "green" projects downstream of two amber/red ones). Hit one live bug along the way: the connector's header field can corrupt a token on entry with no visible error — fixed by revoking and re-minting the token, then removing and re-adding the connector (there's no header-edit path, only remove/re-add). Documented as a "if it 401s" troubleshooting note in the investor guide.
- Deployed to production (`vercel --prod`) — the live smoke test targeted `https://stillnotbald.com/api/mcp`, not just localhost.

**Landing page de-genericization**
- Cut the generic three-badge eyebrow ("AI-native · governance-grade · lite"), trimmed the hero paragraph, dropped a weak "actually" from the headline, decluttered the CTA row from three equal-weight buttons to one primary + one secondary + a quiet sign-in link.
- Replaced the three-card icon+heading+text wedge grid (`web/src/components/marketing/wedges.tsx`, shared with `/case-study`) — flagged by the impeccable skill's own craft-floor as a default AI-slop pattern (same-size cards, colored-bar-as-icon) — with a key/value spec-sheet layout that reads like a CLI flags table, in keeping with the product's terminal-first identity.
- Verified visually (desktop + mobile, Playwright screenshots) on both `/` and `/case-study`; ran the impeccable mechanical detector (clean); lint/typecheck/build/tests all green.
- Deployed to production; confirmed the new headline is actually serving on `stillnotbald.com`.

**Investor demo guide (Artifact, not repo-tracked)**
- Published a one-page guide covering both connect paths (claude.ai Connector + local Claude Desktop/Code) with exact setup steps and a live-demo script, styled in NoPM's own terminal-light tokens. Lives at a claude.ai Artifact URL (private, not shared) — not in this repo; if it needs to survive independent of this session, ask for it to be saved into `docs/` instead.
- One design-hook finding on that artifact (`overused-font: Inter`) — user confirmed intentional (matches NoPM's own `var(--font-inter)` fallback), persisted as a shared exception in `.impeccable/config.json` via `hook-admin.mjs ignore-value overused-font Inter --shared`.

## R-IDs touched
- R-25 → DONE (extended: stdio + Streamable HTTP transports, both verified end-to-end)

## Files
- `web/src/app/api/mcp/route.ts` (new)
- `web/scripts/mcp-http-smoke.mjs` (new)
- `web/mcp/README.md`, `docs/adr/0007-mcp-server.md`, `requirements/REQUIREMENTS.md`, `requirements/TRACEABILITY.md`
- `web/src/app/page.tsx`, `web/src/components/marketing/wedges.tsx`
- `web/src/lib/metrics.gen.json` (regenerated — was stale from prior unpushed work, unrelated to this session's changes, caught by the pre-push freshness gate)
- `.impeccable/config.json` (Inter font exception)

## Tests / verification
- `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run test` (1718 tests), `npm run rtm:verify` — all green after each change.
- `node scripts/mcp-http-smoke.mjs` against both local dev and `https://stillnotbald.com/api/mcp` (production).
- Live claude.ai session: real connector add, real tool-call approval flow, real portfolio data returned.
- `node <impeccable>/scripts/detect.mjs` — no findings on the landing page changes.
- Playwright screenshots at 1440×900 and 390×844 for `/` and `/case-study`.

## Follow-ups
- No OAuth on the HTTP MCP transport — claude.ai's "Add custom connector" UI may expect OAuth discovery on some client versions rather than a static header; the `mcp-remote` local-bridge fallback is documented in `web/mcp/README.md` if that becomes a blocker.
- No CORS configured on `/api/mcp` — untested from a browser-originated fetch; fine for claude.ai's server-to-server call pattern, would need revisiting for any browser-based MCP client.
- The investor guide Artifact is NOT in this repo — it only exists as a claude.ai Artifact tied to the account. Ask for it to be committed under `docs/` if it needs to survive independent of that.
- A pre-existing, unrelated `npm run test:cli` step already covers the CLI contract tests seen in the pre-push hook output — no new work needed there, just noting it's part of the gate.
