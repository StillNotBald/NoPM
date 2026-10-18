# 02 — Root Causes

Status: **DRAFT** — skeleton only, no UAT round has run yet.

## Purpose

The triage sheet. For each UAT ID already recorded in `01-FINDINGS.md`, this sheet records what's actually broken and where — the investigation output, not the retest output. One entry per UAT ID, written once triage happens; if triage turns out wrong (root cause misdiagnosed), append a correction note rather than deleting the original entry.

## Owner rule

**No new UAT IDs are minted here.** Every row in this sheet must reference a UAT ID that already exists in `01-FINDINGS.md`. If investigating a finding surfaces a second, distinct defect, that defect goes back to `01-FINDINGS.md` as its own new row/ID first — it does not get a root-cause entry here without first having a findings entry there.

## Sheet

| UAT ID | Root cause | File(s) / layer implicated | Fix owner (owner / AI session) | Reclassified severity (if changed) | Status |
|---|---|---|---|---|---|
| _(none yet)_ | | | | | |

### Column notes

- **Root cause** — the actual mechanism (e.g. "route validates X but DB CHECK constraint binds Y too," in the style of the wave-1a `rate.limited` uuid `target_id` gap) — not a restatement of the symptom already in `01-FINDINGS.md`.
- **File(s) / layer implicated** — repo-relative paths where the fix will land; this is what a build worker greps for.
- **Status** — moves the parent finding from OPEN → TRIAGED here; the next transition (FIXED-PENDING-RETEST → CLOSED/REOPENED) happens in `03-RETEST-SHEET.md`, not here.

## Log

_(empty — first UAT round has not run)_
