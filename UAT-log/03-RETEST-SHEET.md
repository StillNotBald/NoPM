# 03 — Retest Sheet

Status: **DRAFT** — skeleton only, no UAT round has run yet.

## Purpose

The closure sheet. For each UAT ID that has a fix shipped against its `02-ROOT-CAUSES.md` entry, this sheet records the retest attempt and its outcome — confirming the fix actually closes the finding, in the same environment class the original defect was found in (live/authed, not just unit-test green).

## Owner rules

- **No new UAT IDs are minted here.** Every row references a UAT ID from `01-FINDINGS.md`. A retest that surfaces a *different* defect than the one being retested is a fresh `01-FINDINGS.md` row with its own new ID — never folded into this sheet's row for the original ID.
- **Nothing in this folder — including this sheet — asserts pass/fail counts.** This sheet records one retest outcome per row (Confirmed-fixed / Still-broken / Regressed-elsewhere). It does not roll those up into an "N of M passed" summary; that kind of aggregate belongs in `testing-log/`, sourced from an actual suite run, not from this sheet's row count.
- **A failed retest reopens the same ID.** If a retest fails, the row here records `REOPENED` and a new row is appended for the next retest attempt against that same UAT ID — the ID itself is never incremented or duplicated for a re-fix cycle.

## Sheet

| UAT ID | Retest date | Retested by | Method (page path / API call / script) | Outcome | Status |
|---|---|---|---|---|---|
| _(none yet)_ | | | | | |

### Column notes

- **Method** — must be concrete enough to re-run (a URL path, an exact `curl`/API call, or a named script from `testing-log/README.md`'s index) — not "checked manually."
- **Outcome** — Confirmed-fixed / Still-broken / Regressed-elsewhere (name the new symptom + file a fresh `01-FINDINGS.md` row for it).
- **Status** — CLOSED on Confirmed-fixed; REOPENED on Still-broken/Regressed-elsewhere.

## Log

_(empty — first UAT round has not run)_
