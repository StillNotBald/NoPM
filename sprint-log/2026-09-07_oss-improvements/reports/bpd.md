# BPD task — six new process diagrams (R-93b)

Reverse-engineered six BPMN-style flow diagrams from the live NoPM codebase, following the pattern of the two
existing NoPM specs (`nopm-four-eyes-deletion`, `nopm-timesheet-lifecycle`). All work stayed inside the agreed
file scope: new spec files in the engine's `specs/`, generated HTML copied into NoPM's `docs/processes/`, and
`docs/processes/README.md` written as the index. No existing spec, the engine itself, or any other repo file
was touched.

## Spec files created (engine repo)

`<redacted-path>`

- `nopm-change-request-lifecycle.flow.mjs`
- `nopm-project-lock-rebaseline.flow.mjs`
- `nopm-period-close-reopen.flow.mjs`
- `nopm-agent-token-lifecycle.flow.mjs`
- `nopm-document-control.flow.mjs`
- `nopm-invite-onboarding.flow.mjs`

## Output files (NoPM repo, `docs/processes/`)

| File | Size |
|---|---|
| `change-request-lifecycle-flow.html` | 25.6 KB |
| `project-lock-rebaseline-flow.html` | 27.0 KB |
| `period-close-reopen-flow.html` | 26.2 KB |
| `agent-token-lifecycle-flow.html` | 22.0 KB |
| `document-control-flow.html` | 26.6 KB |
| `invite-onboarding-flow.html` | 26.6 KB |
| `README.md` | index + regeneration rule (new) |

All six are well above the 10 KB floor, each contains 10 `<svg` occurrences (main diagram + legend icon defs +
markers), and `node generate.mjs` reported `Collision self-check: 0 overlaps, 0 proximity violations` for every
one on the final pass.

## Verification performed

1. **Generator collision check** — every spec passes `node generate.mjs specs/<slug>.flow.mjs <slug>.flow.html`
   cleanly (0 overlaps, 0 proximity violations) on the final version.
2. **Headless browser load** (Playwright, using the NoPM `web/` project's installed `@playwright/test`) — all
   six files load with `pageerror`/console-error listeners attached: **0 errors, 10 `<svg>` elements each** on
   the final pass.
3. **Full-page screenshots** — visually inspected all six renders (1400×1000 viewport, full page). Confirmed:
   correct two-column phase layout, legend, fastest-path sidebar, no visible text overflow or clipped `viewBox`,
   groupFrame (dashed teal box) renders correctly for the invite-onboarding atomic-transaction subsequence.

### A real bug the collision check does NOT catch — found and fixed

Two specs (`nopm-period-close-reopen`, `nopm-invite-onboarding`) initially passed the collision self-check with
"0 overlaps" but threw multiple SVG rendering errors (`NaN` coordinates, `undefined` line endpoints) when
actually loaded in a browser. Root cause: a `branches[].fromGateId` pointed at a plain `step`-kind node instead
of a `gate`-kind node. Only `gate` nodes get `cyMid`/`leftX`/`rightX` set during layout; branching off a `step`
node produces `NaN` arithmetic that the collision checker's `rectsOverlap` happens not to flag (both boxes
still get *some* numeric x/y from earlier in that pass, or the comparison silently degrades), but that breaks
real SVG attribute values. Fixed by inserting a dedicated gate node at each of those two branch points
(`editAttemptGate` in period-close-reopen, `rpcGate` in invite-onboarding) and re-verified with a script that
checks every `fromGateId` across all six specs resolves to a `kind: 'gate'` node — confirmed clean — plus a
second full Playwright pass showing 0 errors on all six. **Recommend the engine team add this as an explicit
`generate.mjs` validation** (throw at generation time if `fromGateId` isn't a gate) rather than relying on
downstream browser verification to catch it — filed here as a note, not built, per file-scope limits.

## Facts confirmed from code (worth flagging to the team)

Grounding research (six parallel Explore agents reading routes/migrations directly, cited file:line in each
spec's header comment) surfaced two **confirmed absences** that the diagrams state honestly rather than
fabricate:

- **Change requests have no auto-apply effect.** No code path mutates a project/task/budget when a change
  request is approved — it is a governed record only in this version. Also confirmed: `change_requests` is
  **not** one of the tables guarded by the project-lock trigger (only tasks/milestones/task_dependencies are).
- **Documents have no four-eyes approval.** No `document:approve`/`document:decide` scope exists (unlike
  `change:decide`, `time:approve`, `rebaseline:approve`); the `status` field (draft/in_review/approved) is a
  plain editable field under the same `document:write` scope as any other edit, and no notification fires
  anywhere in the document lifecycle.

One naming correction versus the task brief: there is no separate `periods` table or dedicated close/reopen
REST route. "Period close" is simply a `timesheet_submissions` row reaching `status='approved'`, which a DB
trigger (migration `20260815000040_time_period_lock.sql`) then uses to block new `time_entries` for that
member's week (`P0011`). "Reopen" is the third value of the *same* `/decision` endpoint used for approve/reject,
not a separate feature — the `nopm-period-close-reopen` diagram states this correction explicitly in its
`diagNote` rather than drawing a fictitious periods-admin screen.

Every other fact used in the diagrams (scope names, error codes, RPC/migration names, actor-typed four-eyes
mechanics) was confirmed directly against route/migration source and is cited by file:line in each spec's
header comment block. Nothing in these six diagrams is marked `[UNVERIFIED]` — everywhere the research could
not fully confirm a detail, the spec either states the confirmed absence plainly or omits the claim rather than
guess.

## Not touched (out of file scope)

- The two existing specs (`nopm-four-eyes-deletion.flow.mjs`, `nopm-timesheet-lifecycle.flow.mjs`) and their
  HTML outputs — untouched.
- The engine itself (`generate.mjs`, `svg-kit.md`, `template.html`) — untouched; the `fromGateId`-must-be-a-gate
  finding above is reported, not fixed, in the engine.
- No git commits made.
