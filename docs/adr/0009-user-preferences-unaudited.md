# ADR 0009 — Appearance preferences are non-governance state (unaudited)

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

L-37/L-38/L-42 add appearance preferences (theme mode, text-size scale, table/kanban density, absolute-vs-relative date display). The constitution's default posture is strict: **every mutation = exactly one immutable `audit_log` row** (`writeAudit`, fail-closed) — "no silent writes." Governance is meant to be enforced in the data + API layer for anything that changes state a stakeholder could later ask "who changed this, and when, and why."

The owner presented a carve-out for this class of setting and it went unobjected: **per-user DISPLAY preferences are non-governance state.** This ADR records why that carve-out is sound rather than a quiet erosion of the audit rule, and draws the line precisely so a future feature doesn't smuggle real state through the same unaudited door.

## Decision

Appearance preferences (mode, fontScale, density, dateDisplay — the closed registry in `web/src/lib/theme/appearance.ts`) are:

- **Not persisted to the database.** No table, no row, no `writeAudit` call.
- **Persisted only in a single cookie** (`nopm_appearance`, JSON, 1 year, `samesite=lax`, `path=/`).
- **Per-device, not per-account.** The cookie lives in the visitor's browser; it is never read or written by any `app/api/**/route.ts` handler, never touches `actor.workspaceId`, and carries no PAT/token scope.
- **A closed preset registry, not free-form input.** Four dials (`mode: system|light|dark`, `fontScale: 87.5|100|112.5|125`, `density: comfortable|compact`, `dateDisplay: absolute|relative`), each validated independently against its allow-list on read. There is no color picker, no arbitrary CSS, nothing a visitor can inject beyond flipping between pre-approved presets.

### Why this doesn't need governance

The constitution's audit rule exists so that anyone can answer "what happened to *this data*, and who is accountable." Appearance preferences fail every test that would make that question meaningful:

1. **They affect nothing another user can see.** Theme/density/font-scale/date-format are rendering choices for the viewer's own screen. They never appear in `audit_log`-worthy entities (risks, issues, tasks, budgets, deletions) and never change what those entities *mean*.
2. **They are reversible with zero cost and zero blast radius.** Clicking a different preset is the entire "incident" — there is no data to roll back, no downstream consumer to notify, no stakeholder who was relying on the prior value being stable.
3. **They cannot be used to hide or falsify governance-relevant activity.** A visitor flipping to compact density or relative dates changes only how dates/rows *render locally* — `formatByPref` (`web/src/lib/format/dates.ts`) always keeps the absolute ISO date one hover away (the `title` attribute), so "relative" is a display convenience, never a way to obscure the underlying timestamp that the audited data still carries.
4. **Auditing them would be governance theater.** An `audit_log` row reading "user switched to dark mode" adds noise to the one place NoPM's whole pitch depends on staying trustworthy and scannable — every entry earning its place. This is exactly the class of thing "governance is invisible in operational flows" was written to keep out.

### Why per-device (a cookie), not per-account (a DB column) — the shared-demo-identity angle

NoPM's live demo uses a **single shared Supabase identity** across many real visitors (lesson: `feedback_shared-demo-identity-persistence.md` — per-user state that persists under a shared login leaks across visitors, e.g. one visitor's saved chat appearing for the next). If appearance were stored server-side keyed by `user_id`, the shared demo account would silently become **one global appearance setting for every visitor** — visitor A sets dark mode + compact density, visitor B loads the demo five minutes later and inherits it with no idea why.

A cookie is per-browser by construction: it never crosses devices, never crosses browsers, and is invisible to any other visitor hitting the same shared login. This is the safe-by-construction answer to the same failure mode the shared-demo lesson already named — no per-visitor scoping logic to get right or forget, because the mechanism can't leak in the first place.

## What would NOT qualify for this carve-out

To keep the line legible for future features: anything that (a) another user could see, (b) represents a decision/approval/state-transition on a governed entity, or (c) needs to survive a device change for the *same* accountable human (e.g. a saved report, a notification preference tied to who gets paged) does **not** get this treatment — it goes through the normal API + `writeAudit` (or the assistant/notification-center patterns already in scope) like everything else in the constitution.

## Consequences

- Appearance preferences ship with **zero new API routes, zero new DB tables, zero new audit volume** — nothing to add to `openapi.json`/`llms.txt` for this feature.
- A cookie-cleared or new-device visitor sees the default (light, 100%, comfortable, absolute) again — expected and acceptable; there is no "lost data" here, only a reset display choice.
- If a future requirement needs appearance to *follow the account* (e.g. "remember my density across my laptop and phone"), that is a **new, ask-first decision** — it would mean a DB column + explicit scoping per the shared-demo-identity lesson, not a silent extension of this cookie.
