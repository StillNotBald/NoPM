# 01 — Findings

Status: **DRAFT** — skeleton only, no UAT round has run yet.

## Purpose

The raw intake sheet for user acceptance testing. Every defect a human reviewer reports during a UAT round gets exactly one row here, the first time it's reported, with a new UAT ID. This sheet does not judge root cause (that's `02-ROOT-CAUSES.md`) and does not track fix/retest status beyond a coarse status column (that detail lives in `03-RETEST-SHEET.md`).

## Owner rule

**No new UAT IDs anywhere else in this folder.** A UAT ID (`UAT-001`, `UAT-002`, ...) is minted here, once, in ID order, the first time a reviewer reports the defect. If the same underlying defect is reported twice by different reviewers, it is one UAT ID with two "Reported by" notes, not two IDs — merge on discovery, don't dedupe later.

## Sheet

| UAT ID | Date | Reported by | Page / journey | What was expected | What happened | Severity | Status |
|---|---|---|---|---|---|---|---|
| _(none yet)_ | | | | | | | |

### Column notes

- **UAT ID** — sequential, never reused, never renumbered even if a finding is later judged not-a-bug (mark it `WONT-FIX` with a reason instead of deleting the row).
- **Severity** — reviewer's first-pass judgment (Blocker / Major / Minor / Cosmetic); triage in `02-ROOT-CAUSES.md` may reclassify it, and if so that sheet records the reclassification — this sheet keeps the original call as reported.
- **Status** — see the legend in `UAT-log/README.md`. This sheet only ever sets a row to OPEN (new) or WONT-FIX (owner call, reason inline in a note); every other status transition is driven by the other two sheets and reflected back here.

## Log

_(empty — first UAT round has not run)_
