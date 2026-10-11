# Mobile pass: governance pages (R-94) — report

Mobile hardening for /trust, /approvals, /review, /tokens, /settings, /email-previews, /start, using the shared primitives from the mobile shell pass (FilterSheet, DataList, PageHeader secondaryActions, the `field` utility, `text-2xs`, the sheet hooks). Desktop (>=md) is unchanged everywhere below unless noted.

## Files edited

- `web/src/app/(console)/trust/page.tsx`
- `web/src/components/approvals/actions.tsx`
- `web/src/components/review/queue-list.tsx`
- `web/src/components/review/inline-action.tsx`
- `web/src/app/(console)/tokens/page.tsx`
- `web/src/app/(console)/settings/page.tsx`
- `web/src/app/(console)/email-previews/page.tsx`
- `web/src/components/onboarding/start-checklist.tsx`
- `web/src/components/onboarding/quickstart-snippet.tsx`

No changes were needed in `web/src/app/(console)/approvals/page.tsx`, `web/src/app/(console)/review/page.tsx`, or `web/src/app/(console)/start/page.tsx` — their existing layout already stacks correctly on phones once the components they render were fixed.

## Per-page changes

**/trust** — The filter bar (channel select, action input, Filter/Clear) is now wrapped in `FilterSheet` with an active-filter count; it renders inline unchanged at md+ and collapses to one 44px button below md. Since it's a plain GET form with no client JS, no `onApply`/`onClear` callback was wired — the form's own Filter/Clear controls still do the work via native navigation once opened in the sheet. Timeline entries are restructured into compact cards: the action badge and timestamp now share one row instead of the timestamp hanging as an orphan right-aligned column that used to wrap to below-and-centered on narrow widths; a request id line was added at `text-2xs` (the field existed on the row type but was never rendered). The "Common actions" / "Actor types" / "What this proves" sidebar cards already stack under the timeline below `lg` (single-column grid), so no change was needed there. I did not add a target-entity deep link (e.g. linking a task target to its task) — `target_type` values include several (`api_token`, `deletion_request`, `resource`, `time_entry`) that don't map to `EntityLink`'s `EntityKind`, and most register kinds need a `project_id` the audit row doesn't carry, so a reliable link wasn't in scope for this pass.

**/approvals + /review** — `ApprovalActions` (approvals page) and the `ApprovalInlineAction`/`TimesheetInlineAction` cards (review's inspector) now render Approve/Reject/Withdraw at 44px, full width, stacked on phones (Approve before Reject, matching the existing DOM order), reverting to the original compact inline sizing at sm+. The two-step confirm forms got the same treatment; on phones the button order is visually reversed with `flex-col-reverse` so the primary Confirm sits on top while Back stays first in the DOM/tab order.

For review's inline actions specifically: the confirm/decision buttons are docked as a sticky bar at the bottom of the inspector's own scrollable body (`sticky bottom-0` with a border-top, bleeding to the panel's edges) to read as a sheet footer. I did not wire this through `RightPushPanel`'s real `footer` prop — `useInspector()` (`components/layout/app-shell.tsx`) only accepts `(content, title)` today, no footer slot, and `app-shell.tsx` is out of my file scope. The sticky-bar approach gives the same visual/behavioral result without touching that file; flagging it in case whoever owns app-shell wants to thread a real footer through later. `ChangeInlineAction` (the change-request decision card) was left untouched — it delegates its buttons to `DecisionPanel` in `components/change-control/change-detail.tsx`, outside my scope.

Review's queue rows (`queue-list.tsx`) now wrap onto a second line on phones (`flex-wrap` + `min-h-[44px]`, `sm:flex-nowrap` restores the single-line desktop row) with the title getting the full row width on its own line instead of being truncated to a handful of characters next to four other chips. Two `text-[10px]` literals in this file and `inline-action.tsx` were converted to `text-2xs` per the F8 cleanup.

**/tokens** — Below `md`, the scope picker is a collapsible `<details>` accordion grouped by resource (derived from `scopeChoices()`'s already resource-ordered output), each with a selected-count badge; the flat 2-3 column grid returns unchanged at `md`+. The shown-once token box is full width with a 44px Copy button. The token list now uses `DataList`: the `>=md` table is byte-for-byte the same columns as before, and the `<md` card is fully custom via `renderCard` — name, prefix, a scope-COUNT chip (not every scope badge, which the table still shows), last-used, and Revoke docked in the card's own footer row.

**/settings** — Added a horizontally-scrollable chip row below `sm` (Profile / Appearance / Navigation / Invites / Security / About) that anchor-links to each section (`scroll-mt-20` clears the app's sticky top bar); no client state, so it's essentially free. The MFA secret/OTPAuth boxes already used `break-all` + `block` and fit width with no changes needed. Two more `text-[11px]` section-label literals ("Security", "About") were normalized to `text-2xs` for consistency with the F8 token, even though they were 11px rather than the 8/9/10px F8 explicitly named — flagging this small scope extension.

**/email-previews** — The preview iframe's height is now `min(420px, 60vh)` instead of a flat `420px`, so a short or landscape phone viewport never has the preview pushed off-screen; on any normal-height screen (phone portrait included) this evaluates to the same 420px as before. The iframe already scrolls its own content when taller than the box.

**/start** — The checklist's per-step CTA button and the "Hide this page's checklist" toggle are now 44px (the toggle via padding-and-negative-margin so its visible size is unchanged, same idiom the mobile-shell pass used for page-hint dismiss buttons). The quickstart snippet's CLI/curl tab buttons and its Copy button are now 44px on phones, 28px at sm+. Its code block already had `overflow-x-auto`.

## Verify

- `npx tsc --noEmit`: clean for all files above (pre-existing unrelated errors elsewhere in the tree, from concurrent work outside this scope, ignored).
- `npx eslint` (scoped to the files above): 0 errors, 0 warnings.
- `npx vitest run`: 2018/2018 passed, 90/90 files.

## Live verification (Playwright, 390x844, demo login, read-only)

Screenshots captured to `testing-log/2026-09-07_mobile-ui/after/iphone/`: `trust.png`, `approvals.png`, `review.png`, `tokens.png`, `settings.png`, `email-previews.png`, `start.png` (plus two bonus scroll shots, `tokens-scope-groups.png` and `start-checklist.png`, that landed on other pages — see below).

Confirmed via screenshot and a DOM probe (bounding-rect scan for overflow past the 390px viewport and for real, on-screen interactive elements under 40x40):

- **/trust**: zero horizontal overflow; the filter bar collapses to a single sliders-icon button; timeline cards render with the action+time row, actor row, target row, and `req: ...` line as designed. The only sub-40px elements found are the breadcrumb "NoPM" link and the shared page-hint banner's dismiss button/"Learn more" link — both outside my file scope (shared layout/onboarding components already handled by another worker).
- **/approvals**: Approve/Reject measured exactly 302x44 CSS px, zero overflow.
- **/review**: row titles now show far more text before wrapping (e.g. "Delete task — e2e governed-journey verifi..." vs. the baseline's "Delete t...").
- **/settings**: the section chip row renders and horizontally scrolls; Profile/Appearance/Navigation/Invites are visible with Security/About reachable by scrolling the strip.
- **/email-previews**: preview card and capped iframe render correctly.
- **/tokens** and **/start**: top-of-page renders confirmed (full mint UI, "Connect your agent" card; getting-started tiles + checklist with progress bar).

**Environment note**: the Playwright browser and the `web/` dev server in this session are shared with other concurrently-running mobile-pass agents (I saw the viewport reset to a desktop width mid-check, tabs navigate to `/risks`/`/issues`/`/dashboard`/`/tasks` I never opened, and a `next dev` instance I didn't start already listening). I could not get a stable window to scroll-capture the tokens scope-accordion, the token list cards, or the start-page checklist CTA/quickstart snippet — those attempts got pre-empted by another agent's navigation before the screenshot landed (visible in `tokens-scope-groups.png` and `start-checklist.png`, which show the dashboard and `/tasks` respectively, not my pages). I did not kill any dev server since I never got my own instance to bind (ports 3112/3114/3115 were each already claimed by a lock from a concurrent `next dev`) — I used another worker's already-running server on 3113 for verification and only closed the one browser tab I owned. The unverified pieces (scope accordion open/collapse, DataList token cards, sticky decision-bar on scroll, checklist CTA/quickstart tab sizing) are covered by source review plus the tsc/eslint/vitest checks above, but not by a live screenshot.

Separately, mid-session the shared dev server briefly 500'd on every route with a Tailwind CSS parse error traced to an arbitrary-variant class in `components/dashboard/dashboard-filter-bar.tsx` (`max-sm:[&_.gap-1\.5]:gap-2` or similar) — outside my scope and someone else's file; it self-resolved a few minutes later, presumably once that worker finished their edit. No action taken; flagging in case it recurs for whoever owns that file (dashboard/tracking group).

## Anything else unverified

- The sticky-footer decision bar in `review/inline-action.tsx` (ApprovalInlineAction/TimesheetInlineAction) was not live-scrolled to confirm it actually stays pinned while the panel body scrolls — the CSS (`sticky bottom-0` inside the panel's own `overflow-auto` ancestor) is the same pattern the codebase already documents working for that container, but I'd flag it as a good target for one live check.
- The tokens scope accordion's open/closed disclosure behavior (native `<details>`) was verified in source and matches the pattern used nowhere else in this codebase, so there's no existing precedent to cross-check against, only my own reasoning about `<details>`/`<summary>` semantics and the `group-open:` Tailwind variant.
