# Sprint — Wave 8: UX finish layer + inline-action worklist + form validation + cmd-K search (2026-06-09)

**Intent:** close the flow/UX/form gaps the predecessor-platform comparison surfaced — make the app *feel finished* and turn the Review Queue from a notification list into a real worklist. 4-agent AI-assisted wave (ux-infra · forms · queue-worklist · search) + verify, then an **authenticated end-to-end rehearsal** that caught a real bug.

## Done
- **UX finish layer (ux-infra):** a `ToastProvider`/`useToast` toast system (auto-dismiss, aria-live, theme-token styled) mounted in app-shell; a `Skeleton` primitive + `TableSkeleton`/`CardSkeleton`/`StatGridSkeleton`; **13 `loading.tsx`** skeleton fallbacks (one per heavy console route); a scoped **`(console)/error.tsx`** boundary with "Try again". (Removed a duplicate `ToastProvider` the queue agent added to `(console)/layout.tsx` — kept the app-shell mount.)
- **Forms (forms):** all 9 create/edit forms now do **instant client-side validation** (reusing the route's zod schema via `safeParse`, or a small local schema) so errors show before the round-trip, plus a **success/error toast** on submit. Server validation kept as the backstop.
- **Review Queue → worklist (queue-worklist):** approvals (pending deletions) and change-requests now **decide *beside* the record** — the row opens the right-push inspector with an inline action card (approve/reject/defer + rationale; required reason on deletion reject + confirm), no navigating away. Risks/clashes/docs/rebaselines stay deep-link. Added **kind filter tabs** (All · Approvals · Changes · Risks · Clashes · Docs · Rebaselines) with live counts. Approvals page got the same confirm + required-reason-on-reject + toast.
- **cmd-K record search (search):** new `GET /api/search?q=` (workspace-scoped, 8 entity types, ilike, ~30 cap) + the command palette now shows a **Records** section that deep-links to the matched project/task/risk/issue/clash/document/change-request/decision.

## Rehearsal (end-to-end) — and the bug it caught
- Built a reusable **`scripts/auth-smoke.mjs`**: mints a real admin session server-side (Supabase `generate_link` → `verifyOtp` → `@supabase/ssr` cookie — no password typed) and fetches every console page **as the logged-in admin**, proving the *authenticated* render path (which the data-only `verify-journey.mjs` can't).
- First run: **15/16 — `/trust` 500.** Root cause: the Trust Center renders `shortId(entry.target_id)`, but `audit_log.target_id` is **nullable**, and 5 seeded `risk.create` rows had a null target → `null.length` crash. A pre-existing bug no prior check caught.
- **Fixed:** `trust/page.tsx` made null-safe (`target_id: string | null`, `shortId` returns "—"); `seed.mjs` now links the demo `risk.create` audit row to a real risk id (audit_log is append-only, so the live null rows stay — the page just tolerates them).
- Live UX confirmed in the authenticated `/review` markup: all 6 filter tabs, all 5 governance groups, **14 inline-action `<button>` rows + 14 deep-link rows** (the worklist split), dashboard 6/6 projects.

## Verification
- `tsc --noEmit` clean · `next build` clean (45 pages) · `vitest` 102/102 · `verify-journey` 16/16 · `auth-smoke` 16/16 (after the trust fix) · deployed READY to stillnotbald.com.

## Open / deferred
- Toast aria-live region is rendered on-trigger (not in static SSR) — fine, but a permanently-mounted empty live region would be marginally better for SR users.
- Inspector still singleton + no focus-trap (pre-existing); cmd-K search is ilike (fine at demo scale).
- Live **visual** walk-through still needs the Claude Chrome extension connected (it was offline this session); the authenticated smoke is the headless substitute.

## Status
Flow/UX parity push complete: the review queue is now a decide-beside-the-record worklist, every mutation gives instant validation + toast feedback, skeletons/error-boundaries make it feel production-grade, and cmd-K finds records. End-to-end rehearsal is now a one-command, repeatable check.
