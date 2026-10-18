# UC-21 · Saved views and navigation modes

**Goal:** Let a person configure how a register looks (filters, sort, columns, grouping) and how much of the product's surface area they see, without writing code, and without one person's configuration leaking to another.

**Actors:** Project Manager, Team member.

**Preconditions:** A signed-in session on a register page (e.g. `/tasks`).

**Trigger:** A person wants to reuse a specific filtered/sorted/grouped view of a register repeatedly, or wants the sidebar to show more (or fewer) modules than the default.

## Main flow — saved views

1. On a register page, configure filters, sort, columns, and group-by via `<FilterBar>`, `<GroupBySelect>`, `<ColumnChooser>` — all URL-encoded, server-side paginated.
2. Save the current configuration: `POST /api/saved-views` (scope `saved_view:write`) — `scope: personal|shared`. A token/agent caller is always forced to `scope=shared` (there is no owning identity for a "personal" view from a token).
3. Reopen: `GET /api/saved-views` (scope `saved_view:read`) lists own personal views plus every shared view in the workspace — never another identity's personal view. Reopening via `?view={id}` reproduces the exact filters/sort/columns/group-by; a view referencing since-deleted data degrades gracefully (whatever filters still resolve), never a `500`.
4. Share or protect: `PATCH /api/saved-views/{id}` (owner or admin only, `403` otherwise) toggles `scope`/`protected`, both audited (`saved_view.shared`/`saved_view.protected`). A protected view `403`s a config-changing PATCH unless the same call also unprotects it.
5. Duplicate: `POST /api/saved-views/{id}/duplicate` (user sessions only) clones any visible view, including a protected one, into a fresh unprotected personal copy owned by the caller.
6. Delete: `DELETE /api/saved-views/{id}` — plain hard delete, single-step, audited, not maker-checker.
7. A per-view aggregate footer shows count plus numeric column sum/average **over the rows on the current page**, explicitly labeled "(current page)" rather than implying a whole-register total the list API doesn't return.

## Main flow — navigation and appearance

1. The sidebar defaults to **Essentials** mode (7 core modules) for brand-new accounts and the demo login; "Show all modules" and Settings → Navigation & help both expand to the full catalogue. Precedence: a per-device `nopm_nav` cookie → the account's `nav.mode` DB mirror (non-demo only) → `all` for any account that already has a preferences row (existing users are never moved under them).
2. Appearance (theme mode, text-size scale, table/kanban density, absolute-vs-relative date display) lives on Settings → Appearance as four segmented controls, backed by a **closed preset registry** (no free-form input), persisted in one cookie (`nopm_appearance`, 1 year) and applied live without a full reload.
3. `GET`/`PUT /api/me/preferences` (user session only) is the DB-backed store behind saved column/group-by choices per register, density, date display, and default landing page. `PUT` is a **merge-upsert**: top-level keys override, `columns`/`groupBy` merge per register, omitted keys are preserved, unknown keys are stripped (never rejected), and the merged result is capped at 10KB serialized size (`422` over the cap or on an unrecognized value for a whitelisted key).

## Alternate and exception flows

- **A personal view accessed by a non-owner** → `404`, never `403` — a deliberate non-leaking shape (RLS for session users, an identical `isVisibleToActor` predicate applied explicitly for token/agent callers who bypass RLS via the admin client).
- **A token/agent attempts to own a personal view** → blocked by the DB's `saved_views_personal_needs_owner` CHECK constraint.
- **Editing a protected view without unprotecting it in the same call** → `403`.
- **Per-user preferences (`user_preferences` / the appearance cookie)** are a deliberate, owner-approved **audit carve-out** (ADR 0009): zero `writeAudit` calls, zero DB audit rows — reasoning is nothing another user can see, zero blast radius, and an audit row here would be governance theater. Contrast this explicitly with `saved_views`, which **are** fully audited workspace data since other people can see and be affected by a shared/protected view.
- **The shared demo login** → never persists appearance, navigation mode, or `user_preferences` to the DB (client code checks `isDemoActor` and skips the `PUT` entirely) — a documented, tested guard against one demo visitor's configuration leaking to the next (see memory `feedback_shared-demo-identity-persistence`).

## Postconditions

- `saved_view.create/update/shared/protected/delete` — one audit row per governed mutation.
- `user_preferences`/appearance cookie changes write **no** audit row (the explicit carve-out).

## Reporting and evidence

- `<SavedViewsBar>` on `/tasks` is the reference implementation of this whole pattern (Save view button, Views dropdown with Personal/Shared sections, share/protect/duplicate/delete icon actions).
- The Settings page groups Appearance and Navigation & help as the non-code configuration surfaces this use case is built to demonstrate (outcome: frontend flexibility).

## Traceability

- R-IDs: R-72 (saved views + shared view config), R-69 (appearance system), R-43 (navigation IA), R-78 (progressive-disclosure onboarding — Essentials sidebar mode), ADR 0009 (per-user unaudited preferences, amended 2026-08-15 for `user_preferences`).
- Key files: `web/src/app/api/saved-views/route.ts`, `web/src/app/api/saved-views/[id]/route.ts`, `web/src/app/api/saved-views/[id]/duplicate/route.ts`, `web/src/app/api/saved-views/_visibility.ts`, `web/src/components/registers/saved-views-bar.tsx`, `web/src/lib/theme/appearance.ts`, `web/src/lib/nav/nav-mode.ts`, `web/src/app/api/me/preferences/route.ts`, migrations `20260815000035_saved_views.sql` and `20260815000036_user_preferences.sql`, `docs/adr/0009-user-preferences-unaudited.md`.
- Tests: `web/src/lib/theme/appearance.test.ts`, `web/src/lib/format/dates.test.ts`, `web/src/lib/auth/scopes.test.ts` (`saved_view:read`/`write`).

## Open questions

None outstanding for this use case; both R-72 and R-69/R-78 were read in detail from `requirements/REQUIREMENTS.md` and cross-checked against the ADR reference.
