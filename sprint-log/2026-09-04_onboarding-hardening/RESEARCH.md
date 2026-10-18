# ClickUp user-complaint research (2025–2026)

**Purpose:** input to NoPM's onboarding + navigation simplification sprint (this sprint folder). NoPM is deliberately *lite*; this list is a menu of failure modes to avoid, not a parity list.

**Method:** 14 Reddit threads read live (r/clickup, r/projectmanagement — r/productivity and r/SaaS had no substantive ClickUp threads this year), 2 Hacker News threads, ClickUp's public feedback board (4 threads), Capterra 2025–26 reviews, Trustpilot, 5 review roundups. Scores/dates as of 2026-09-04.

## Top 10 recurring complaints (ranked by upvotes × recurrence)

1. **Every release breaks something; bugs sit for months.** "Every release, baseline features and functionality break. Bugs linger on for weeks, months, years" (121 pts, Mar 2026). https://www.reddit.com/r/clickup/comments/1rxbtla/ · "constantly launch and promote new features instead of fixing existing bugs" (40 pts) https://www.reddit.com/r/clickup/comments/1o87jcf/
2. **Slow.** "Simple actions, switching from List to Board... feel sluggish. It's like using a computer from 2008" / "stop adding features, fix the speed" (68 pts) https://www.reddit.com/r/clickup/comments/1qgdr84/ · card typing "freezing for 1-2 seconds before rubber-banding back" (35 pts) https://www.reddit.com/r/clickup/comments/1rlvr0r/ · feedback board Jan 2026 https://feedback.clickup.com/feature-requests/p/web-app-performance-and-speed-issues · G2 tags "Slow Loading" in 1,154 reviews https://checkthat.ai/brands/clickup/reviews
3. **Interface clutter and redesign churn.** "Why in the world do I need so many buttons that I don't even use... I just need something SIMPLE and FAST" (43 pts); top reply "It used to be simple and smart. Now it is complex and dumb" https://www.reddit.com/r/clickup/comments/1s7uhzh/ · Sidebar showing every Space is "SO overwhelming to look at when I am just trying to focus down on one Space" (60 votes) https://feedback.clickup.com/feature-requests/p/bring-back-clean-layout-on-the-sidebar-for-separation-of-spaces · HN: "a confusing mess. It tries to be the centre of your universe" https://news.ycombinator.com/item?id=31936540
4. **First-run decision overload.** "when you open it for the first time, it asks you to make 10 decisions before you've done anything useful. Spaces, Folders, Lists, Views, Docs" (18 pts, May 2026) https://www.reddit.com/r/clickup/comments/1ts3rsa/ · G2: "Learning Curve" is the #2 complaint (1,752 mentions); Ease of Setup lowest score at 8.2 · Capterra Apr 2026: "The interface is overwhelming and onboarding new team members takes longer" https://www.capterra.com/p/158833/ClickUp/reviews?page=4
5. **Notification noise from defaults.** Auto-watch: "every single task I create or edit automatically assigns me as a watcher and then sends me an email" (1.3k votes) https://clickup.canny.io/feature-requests/p/disabling-auto-assinging-watchers · some categories cannot be switched off (192 votes) https://feedback.clickup.com/feature-requests/p/allow-required-notification-settings-to-be-turned-off
6. **AI upsell modals forced into core paths.** "every time I start it up theres a new bloody popup trying to get me to use an AI feature" (28 pts, Jun 2026) https://www.reddit.com/r/clickup/comments/1uhrasp/ · "you can't even do a simple search anymore because it goes thru the poorly implemented ai" (16 pts) https://www.reddit.com/r/clickup/comments/1s7uhzh/
7. **Features moved/removed without notice; defaults changed on users.** 4.0 removed drag-to-timeblock from Home; workaround "now has an extra 4 steps", "first load time is over 8 seconds" (29 pts, Mar 2026) https://www.reddit.com/r/clickup/comments/1rz097v/clickup_40_absolutely_mangleddowngraded_the_home/ · "forced to come into work one day and re-learn or re-configure their way of life" https://www.reddit.com/r/clickup/comments/1rxbtla/ · ZenPilot: "Plan for 1-2 weeks of 'where did everything go?'" https://www.zenpilot.com/blog/clickup-4-review/
8. **Support goes quiet.** 30 seats, bugs unresolved 3+ months: "we also asked to pay for solving issues but we have been ignored" (25 pts, Oct 2025) https://www.reddit.com/r/clickup/comments/1nkcrub/clickup_support_is_horrible/ · Trustpilot Aug 2026 https://www.trustpilot.com/review/clickup.com
9. **Mobile is second-class.** "The 2026 mobile app is still a disaster... Boards and Dashboards are nearly impossible to navigate" (29 pts) https://www.reddit.com/r/clickup/comments/1sez7gt/ · (21 pts, Jan 2026) https://www.reddit.com/r/clickup/comments/1q56kki/
10. **Surprise billing / tier moves.** Inviting limited members silently raises seat count: "The surprise comes as an invoice" (29 pts) https://www.reddit.com/r/clickup/comments/1n909bg/

**Bonus signal — self-inflicted complexity.** A 10-person org owner: "my guys were spending 1-2 hours a day managing clickup instead of actually doing the work" (33 pts) https://www.reddit.com/r/clickup/comments/1w5ob0z/

## What good onboarding looks like, according to users

- **First win before first decision.** Land in a workspace where one useful thing happens within 60 seconds; hierarchy choices come later, on demand.
- **Teach five concepts, nothing more.** The org owner above replaced tutorial playlists with 1–3 short videos covering task, status, comments, notifications, description: "Rarely I NEED to have them learn all the features. Like basically never."
- **Process first, product second.** Failed rollouts came from picking features before naming the business outcome https://www.reddit.com/r/clickup/comments/1phti33/
- **Features off until needed.** "You can disable the slop." Hide Gantt/workload/dashboards/exports until there is real data, then surface each with a one-line "why now".
- **Quiet by default.** Notify on assignment + direct mention only; every category switchable off; no auto-watch.
- **Speed is onboarding.** Leavers compare to Asana as "fast, responsive, and uncluttered, which of course means it has fewer features" — and accept that trade.
- **Stable defaults, announced changes.** Never move/remove a workflow without an in-product note and a way back.
- **Empty states that teach.** Each empty register shows the one action that fills it.
- **For an API-first tool:** the first win is a copy-paste quickstart that creates a project and a task and then shows the audit row it produced — one command, one visible governance receipt.

## Anti-patterns to avoid

- Up-front hierarchy wizard before any task exists.
- Feature buffet on by default (ClickApps toggles, 15+ optional fields, every view enabled).
- Stacking promotional modals (especially AI); closing one does not stop the next.
- Routing a core action (search) through an AI layer.
- Auto-watch / notification categories that cannot be disabled.
- Moving/removing features or changing defaults in a release without notice.
- Sidebar showing everything at once with no focus mode.
- Copying a competitor feature as "yet another view" instead of improving the core.
- Silent seat-count increases / features migrating to higher tiers.
- "All systems operational" while users report breakage; support that acknowledges but never closes.

## How NoPM applies this (sprint 2026-09-04)

| Complaint | NoPM response |
|---|---|
| #3 sidebar clutter (22 items / 5 sections) | **Essentials** nav mode (7 items) as the default for new users, "Show all modules" one click away; the active page is always visible so nobody gets lost; per-device + per-account persistence; a way back in Settings. |
| #4 decision overload | First-run wizard stays at 2 inputs (code + name); new data-driven **Getting started** page turns real workspace state into a 5-step checklist (first win, audit receipt, connect agent). |
| Features off until needed | Non-essential modules hidden in Essentials mode; one-line dismissible **page hints** explain a page's purpose the first time it is opened — no modals, no stacking (max one onboarding surface per page). |
| #6 AI upsell modals | Assistant stays a header button; zero promotional modals; hints and tour are dismissible once and stay dismissed. |
| #2 speed | Client-side preferences store dedupes the per-page `GET /api/me/preferences` fan-out; project page stops loading every dependency edge in the workspace. |
| #1 stability | Preferences PUT changed to merge semantics (dismissing a card no longer wipes saved columns); HTTP security headers + CSP added with a production-build console sweep. |
| #7 stable defaults | Existing users keep the full sidebar (nav mode defaults to "all" when a preferences row already exists — only brand-new accounts default to Essentials). |
| #5 notification noise | Already quiet (governed events only, no auto-watch); noted as a guard-rail for future notification work. |
