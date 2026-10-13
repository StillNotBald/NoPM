# Sprint — Wave 6: Harden + Land (2026-06-09)

**Intent:** close out the v1 MVP — expand the governance test suite to cover Waves 3-5, verify the persona journeys end-to-end at the data layer, and finalize the RTM / sprint-log. The build-out is complete; this wave is about provable correctness and landing.

## Done
- **Test suite 34 → 102** (all green; `npm test`). An AI implementation agent added 68 governance-invariant unit tests, no production code touched:
  - `src/lib/crypto.test.ts` (14) — BYOK key crypto: encrypt/decrypt round-trip (ascii/unicode/long/empty), random-IV non-determinism, **GCM tamper detection**, wrong-key failure, missing-key error.
  - `src/lib/assistant/scopes.test.ts` (28) — the assistant's governance envelope: `TOOL_SCOPES` **includes** `task:delete:request` but **excludes** `task:delete:approve`, every `token:*`, and any mfa scope. Proves via `hasScope` that the assistant can *request* a deletion but can **never approve** one — maker-checker is preserved even for the AI actor.
  - `src/lib/documents/storage.test.ts` (26) — path-safety: `sanitizeFileName` strips `/`/`\` separators (the real traversal vector in flat object storage), `buildStoragePath` locks the `workspaceId/documentId/` prefix, `validateStoragePath` rejects foreign-workspace prefixes.
- **Authenticated journey verification** (`scripts/verify-journey.mjs`) — connects as the admin user **under RLS** (`request.jwt.claims`) and asserts every console page renders populated, workspace-scoped data via the exact query path the server components use. **16/16 pass:** dashboard (6 projects / 4 open risks / 6 issues), clashes, resources, documents (19 total / 19 with a stored file / 5 in_review), change-control (8 / 3 under_review), decisions (6), review-queue sources, notifications (3), audit_log (37). Includes an explicit **four-eyes integrity assertion**: zero self-decided change requests in the DB.
- **RTM finalized** — R-60 updated to the 102-test suite + the three new test files; full matrix green.

## Verification
- `npm test` → **102/102**. `npm run rtm:verify` → **39 R-IDs / 145 paths**. `tsc` + `next build` clean. All five waves deployed to stillnotbald.com.
- Governance invariants now machine-checked: audit immutability, scope enforcement, four-eyes (deletion + change-request), BYOK crypto integrity, assistant scope ceiling, storage path isolation.

## Open items (owner input required)
- **Visual persona walk-through + assistant chat demo** — best done together: the chat needs an owner demo key (`NOPM_DEMO_LLM_PROVIDER/KEY/MODEL` on Vercel), and a live click-through is more useful with her watching. Everything beneath is verified + live.
- Minor polish carried forward: dedicated `change.decided` notification type; right-push viewer snapshot refresh after live file attach/remove (ADR 0005); R-51 one-pager PDF; R-61 Playwright E2E (post-v1 stretch).

## Status
v1 MVP build-out complete across Waves 2-6: persona journeys + notifications, BYOK governed assistant, documents with real file storage, review queue, change-control + decision log — all deployed, audited, tested, and traceable.
