# UAT Log

Status: **DRAFT** — no UAT round has run yet against this codebase; this folder is scaffolding for the first one.

## Purpose

`UAT-log/` is where **user acceptance testing** — a human reviewer (owner, or a stand-in playing a client/stakeholder role) working through the product and recording what they find — gets tracked from raw finding to closure. It is a separate discipline from `testing-log/` (automated/scripted evidence: vitest, Playwright, smoke scripts, live-DB probes) and from `sprint-log/` (build receipts). UAT starts from a human's judgment of whether the product does what it's supposed to, not from a script's pass/fail.

The folder holds three numbered documents, in the order a UAT round moves through them:

1. **`01-FINDINGS.md`** — the raw intake. Every UAT defect gets a UAT ID here, once, the first time a reviewer reports it.
2. **`02-ROOT-CAUSES.md`** — the triage layer. Each UAT ID from `01-FINDINGS.md` gets a root-cause note once someone (owner or AI) investigates it — what's actually broken, and where.
3. **`03-RETEST-SHEET.md`** — the closure layer. Each UAT ID gets a retest entry once a fix ships, recording whether the retest confirmed the fix.

## Owner rules (do not violate these when filling the templates in)

- **No new UAT IDs in `02` or `03`.** A UAT ID is minted exactly once, in `01-FINDINGS.md`, at first report. If a retest in `03-RETEST-SHEET.md` turns up a *new* defect (not the one being retested), that new defect is a fresh row in `01-FINDINGS.md` with its own new UAT ID — it does not get folded into the parent's ID or silently absorbed into the retest note. Defects found **during** a retest attach to the ID being retested only if they are literally the same defect surfacing again (a failed fix); anything else is new.
- **Nothing in this folder asserts pass/fail counts.** `UAT-log/` records individual findings, their causes, and their retest outcomes — one row at a time. It does not summarize "N of M passed" anywhere. Aggregate results (suite pass counts, coverage numbers, wave-close verification) live in `testing-log/` and `sprint-log/`, not here. If you find yourself wanting to write a summary count in this folder, that number belongs in a `testing-log/` dated entry instead.

## Status legend (used in all three sheets)

| Status | Meaning |
|---|---|
| DRAFT | Skeleton only — no real UAT round has populated this yet. |
| OPEN | Finding reported, not yet root-caused. |
| TRIAGED | Root cause recorded in `02-ROOT-CAUSES.md`. |
| FIXED-PENDING-RETEST | A fix has shipped; retest not yet run. |
| CLOSED | Retest confirmed the fix in `03-RETEST-SHEET.md`. |
| REOPENED | Retest failed — the same UAT ID gets a new row in `03-RETEST-SHEET.md`, not a new ID. |
| WONT-FIX | Owner decision to leave as-is, recorded with a one-line reason. |

## Current state

All three sheets are DRAFT skeletons — see each file. No UAT round has been run against this build. When the first round happens, start at `01-FINDINGS.md`.
