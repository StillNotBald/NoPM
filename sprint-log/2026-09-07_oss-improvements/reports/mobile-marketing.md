# Mobile pass — landing, case study, login (R-94) — report

Scope: `web/src/app/page.tsx`, `web/src/app/case-study/**`, `web/src/app/login/**`, `web/src/components/{marketing,case-study,auth,demo-login-button.tsx}/**`. Read first: `testing-log/2026-09-07_mobile-ui/FINDINGS.md`, `web/src/components/ui/MOBILE.md`, baseline screenshots. No git commits made.

## What the baseline actually showed

The FINDINGS.md summary table already recorded landing/login as passing ("readable, CTAs >= 44px, nav collapses" / "inputs full width, demo button visible without scrolling") and the Ranked Findings (F1-F10) are all console-app pages (dashboard, panels, registers) — none targeted the marketing pages. The baseline screenshots confirmed this: no document overflow, `WedgeGrid` is already a `dl` field-list (not a table), `TerminalCard`'s code block already scrolls (`overflow-x-auto`), and case-study's proof-metrics were already a 2-column grid at mobile (`grid-cols-2 sm:grid-cols-5`). Two items from the assignment's goal list — an "agent-surfaces table" and standalone "proof-metric counters" on the landing page — do not exist in the current landing page; I did not invent them. I focused on the concrete, real gaps below.

## Changes made

**New:** `web/src/components/marketing/mobile-nav.tsx` — `MobileNavMenu`, a 44px hamburger button + sheet for marketing-page nav, built on the shared `useBodyScrollLock` / `useInertShell` / `useReturnFocus` hooks (`lib/hooks/use-sheet.ts`) that `RightPushPanel`/`Modal`/the notification bell already use, so behavior (scroll lock, app-shell inert, focus return, Escape-to-close) is consistent with the rest of the product. No new dependency.

**`web/src/app/page.tsx` (landing):**
- Nav: below `md`, "Case study", "Raise a change request", "Agent API", "OpenAPI" move into `MobileNavMenu`; "Open console" stays inline. Above `md`, unchanged from before.
- Hero CTA row: `DemoLoginButton` and "Read the agent API" are full-width and stacked below `sm`; "Sign in ->" stays a small inline link. Unchanged at `sm`+.
- Hero `h1`: uses a mobile-only `clamp()` below `sm` instead of a flat `text-4xl`, so it scales smoothly from 360px to 640px; `sm:text-5xl xl:text-6xl` untouched.
- Footer: "Raise a change request" and the `stillnotbald.com` mark get an invisible 44px-tall hit box (no visual change, row height is already governed by the footer's own padding).

**`web/src/app/case-study/page.tsx`:**
- Nav: same `MobileNavMenu` pattern — "Home" and "Sign in" move into the menu below `md`; the demo button stays inline at every width.
- "Reviewed, then closed" table: first column (`Finding (morning)`) is now `sticky left-0` so it stays visible while scrolling the table horizontally on phones, on top of the `overflow-x-auto` wrapper it already had.
- Bottom CTA row and hero CTA row: the three bordered "Sign in ->" / "OpenAPI spec" / "Agent API (llms.txt)" buttons get `max-sm:min-h-[44px]` (were ~40px); the plain-text "Sign in ->" and `stillnotbald.com` links in the hero row get an invisible 44px hit box.

**`web/src/components/demo-login-button.tsx`:** the button itself gets `min-h-[44px] sm:min-h-0` plus flex centering. This one change fixes real sub-44px targets in three places at once: the case-study nav variant (was ~32px), the landing/case-study hero variant, and the login page's primary demo CTA — all reset to their original size at `sm`+.

**`web/src/components/case-study/download-button.tsx`:** `DownloadOnePagerButton` (`Button size="sm"`, 32px) gets `max-sm:h-11`.

**`web/src/app/login/page.tsx`:**
- Both submit buttons (credentials "Sign in", MFA "Verify") get `max-sm:h-11` — they were `size="md"` (40px) on every width.
- The "Use a backup code instead" toggle had no height at all (a `text-xs` line with no padding, well under 44px); now `flex min-h-[44px] items-center justify-center`.
- Everything else the task asked about was already correct: `Input` already applies the shared `field h-11 sm:h-10` utility (full width, 44px on phones); the MFA code field already has `inputMode="numeric"` and `autoComplete="one-time-code"`; the demo button and its caption sit well above the fold at 360x800 (nothing above them but the wordmark and one card).

## One locked-decision conflict, resolved

`web/src/app/landing-mobile.test.ts` is a pre-existing source-scanning test from an earlier wave that pinned "nav stays pure CSS visibility, no hamburger" as a locked decision, and gated the hidden links at `sm` (640) rather than `md` (768). That directly conflicts with this task's explicit ask (a 44px menu button revealing hidden links). I judged the current, explicit instruction as superseding the older lock — the gap it was locking against (unreachable links below 640px) is exactly what the hamburger now fixes — and rewrote the test's 14 assertions to check the new invariants (menu present, gated `md:hidden`, carries every link removed from the inline nav; breakpoints moved to `md`). I flagged this decision here rather than applying it silently. Full suite: **2018/2018 passing** after the rewrite (was 6 failing against the old lock).

## Verification

- `npx tsc --noEmit`: no errors in any file I touched. (There are pre-existing errors in `components/registers/issue-detail.tsx` and `components/timesheets/report-filters.tsx` from other in-flight agents' work — unrelated to this task, not fixed here.)
- `npx eslint` on all touched/created files: 0 errors, 0 warnings.
- `npx vitest run`: **2018/2018 passing**, including the rewritten `landing-mobile.test.ts`.
- Live Playwright verification (390x844, 360x800, and a 1280x800 desktop diff-check) **could not be completed**: the local dev server returns 500 on every route. Root cause is a PostCSS/Tailwind parse failure in `web/src/app/globals.css`'s generated output, traced to an invalid arbitrary-variant selector in `web/src/components/dashboard/dashboard-filter-bar.tsx:66` (`max-sm:[&_.gap-1\.5]:flex-col` — the escaped-dot child selector doesn't parse). That file is outside this task's scope (owned by the tracking/dashboard mobile pass) and was still present after retrying the dev server twice over ~90 seconds. This blocks the whole site, not just my three pages, so it will need fixing by whoever owns `dashboard-filter-bar.tsx` before anyone can get a live mobile render.

## Recommendation

Once the dashboard CSS bug is fixed, a quick live pass on `/`, `/case-study`, `/login` at 390x844 and 360x800 would be worth doing to confirm the hamburger sheet opens/closes cleanly and the sticky table column renders as expected — the changes here are verified correct by source/type/lint/test but not yet pixel-confirmed in a real browser.
