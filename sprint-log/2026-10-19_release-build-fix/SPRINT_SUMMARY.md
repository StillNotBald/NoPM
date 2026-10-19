# Sprint Summary — 2026-10-19_release-build-fix

**TL;DR:** The wave-5 release (main bf064ed) stopped at the Vercel build: a client component reached `next/headers` through a chain of static imports. One import moved, one guard test added so vitest catches the class from now on. No migration was applied and live was untouched.

## Declared goals
- Make main bf064ed build on Vercel (the release script's step 4) without changing behaviour.
- Add the missing gate: the failure was visible only to `next build`, which is not in the pre-push hook.

## Actual outcomes
- Turbopack error: "You're importing a module that depends on next/headers ... in the Pages Router", three times (guard.ts, mfa.ts, supabase/server.ts), all through one chain:
  `components/review/inline-action.tsx` ("use client") → `lib/review/deletion-target.ts` → `lib/review/pending.ts` → `lib/governance/deletion-dispatch.ts` (wave 5, W5-G) → `lib/auth/guard.ts` → `next/headers`.
  Before wave 5 the same chain stopped at `pending.ts` (type-only import of `Actor`); W5-G added value imports from `deletion-dispatch.ts`, which imports `requireScope` from the guard.
- Fix: `clip()` moved to `lib/review/text.ts`; `deletion-target.ts` and `gather.ts` import it from there; `pending.ts` re-exports it for existing callers. `deletion-target.ts` no longer imports `pending.ts`, so the client bundle never reaches the guard. No runtime behaviour changes.
- Guard: `src/lib/client-server-boundary.test.ts` walks every `"use client"` file's static value imports (`@/` and relative, type-only skipped) and fails with the full chain when one reaches a module importing `next/headers` or `server-only`. Run on the unfixed tree it reported exactly the two chains Vercel rejected (inline-action.tsx and queue-list.tsx); on the fixed tree it passes.
- Release script `_docs/nopm-release-2026-10-19-wave5.sh` (outside the repo): step 4 now reads the Vercel output from a file and stops with a plain "BUILD FAILED, live untouched" line instead of exiting silently.

## R-IDs touched
- none (build integrity; R-176/R-177 behaviour unchanged)

## Files
- `web/src/lib/review/text.ts` (new), `web/src/lib/review/pending.ts`, `web/src/lib/review/deletion-target.ts`, `web/src/lib/review/gather.ts`
- `web/src/lib/client-server-boundary.test.ts` (new)

## Tests / verification
- Boundary test red on bf064ed (2 chains), green after the fix; `src/lib/review` suite 164/164; `tsc --noEmit` 0 errors; eslint clean on the changed files.
- `npm run build` (Turbopack production build) run locally on the fixed tree: see the PR for the result line.
- Pre-push gates (typecheck, full vitest, rtm:verify, metrics freshness, CLI) on push.

## Follow-ups
- `next build` is still not in the pre-push hook (minutes, memory-heavy). The new test covers the `next/headers` class; route-export misuse is covered by `app/route-exports` tests. Anything else only the bundler sees still needs a build before a release, which the release script does before any migration is applied.
- Re-run the release with the new main SHA in `EXPECT_SHA`.
