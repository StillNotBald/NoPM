# Process diagrams (BPD)

Eight BPMN-style, end-to-end business process diagrams for NoPM. Each is a self-contained, print-ready HTML
file with inline SVG — happy path down the centre, exception branches (403/422/lock) to the side, decision
diamonds for approvals and four-eyes gates, and ✉/🔔 markers wherever an email preview or in-app notification
fires. All eight are reverse-engineered directly from the live code (routes, RPCs, and migrations), not from
intent or documentation — where the code does not do something a reader might assume (a missing notification,
an unenforced approval, a table that doesn't exist), the diagram says so explicitly instead of drawing it in.

## Index

| Diagram | What it covers |
|---|---|
| [`four-eyes-deletion-flow.html`](./four-eyes-deletion-flow.html) | Task/project deletion as a maker-checker decision: a maker requests with a mandatory reason, scope and project-lock gates guard the request, a different checker approves or rejects in the Review Queue, and self-approval is blocked in triplicate (API guard, Postgres function P0003, and a DB CHECK constraint) before an atomic commit deletes the target and writes both audit rows in one transaction. |
| [`timesheet-lifecycle-flow.html`](./timesheet-lifecycle-flow.html) | Logging and submitting time through four-eyes approval and a database-trigger lock: a member logs and submits a week, a different approver decides (self-approve *and* self-reject both blocked), and an approved week is frozen by a DB trigger — with a governed "reopened" third verb and period close layered on top. |
| [`change-request-lifecycle-flow.html`](./change-request-lifecycle-flow.html) | Raising a change request and deciding it under actor-typed four-eyes (requester vs. decider compared by actor type + id, migration 0043), blocked in two layers (API guard + DB CHECK). Reverse-engineering surfaced two confirmed absences worth knowing: a locked project does **not** block change requests, and an approved change request has **no automatic effect** on the project/task/budget it describes — it is a governed record, not an executor, in this version. |
| [`project-lock-rebaseline-flow.html`](./project-lock-rebaseline-flow.html) | Locking a project, attempting a schedule-shape edit while locked (blocked twice — an app-layer guard and a Postgres trigger raising `P0010`, with only one deliberate bypass scoped to the rebaseline-apply RPC), requesting and signing off a rebaseline under four-eyes (`P0003` backstop), applying it, and unlocking as a separate, independently-reasoned governed verb. |
| [`period-close-reopen-flow.html`](./period-close-reopen-flow.html) | What happens *after* a timesheet week is approved: approval itself is the lock (a DB trigger, migration 0040, blocks new time entries with `P0011`), and "reopen" is not a separate feature but the third value of the same decision endpoint used for approve/reject — same four-eyes rule, a mandatory rationale, and a full reset back into the Review Queue as a brand-new approval request. Companion to the timesheet-lifecycle diagram, which covers log → submit → approve. |
| [`agent-token-lifecycle-flow.html`](./agent-token-lifecycle-flow.html) | Minting a scoped personal access token (admin/manager-only, shown once, SHA-256 hash stored), an agent calling in over MCP/CLI/REST with that Bearer token, the scope check that fails closed with a named-missing-scope 403, the single audit row written per call (actor, channel, request id), and revocation as an immediate boolean flip with no propagation delay. |
| [`document-control-flow.html`](./document-control-flow.html) | Creating a document record, a signed direct-to-storage upload (the browser PUTs bytes straight to object storage — NoPM compute never touches the file), attach-time verification (storage path ownership, object existence, MIME normalization, and magic-byte verification for the five inline-safe types), and MIME-driven inline-vs-forced download. Reverse-engineering confirmed there is **no** dedicated approval scope or four-eyes rule for document status today — one actor can move a document from draft to approved unilaterally, and no notification fires anywhere in this lifecycle. |
| [`invite-onboarding-flow.html`](./invite-onboarding-flow.html) | An admin/manager creating a role-capped, single-use, 7-day invite; acceptance colliding every failure reason (used, revoked, expired, unknown) into the identical anti-enumeration 422; the atomic `nopm_accept_invite` transaction that creates the auth user's profile and workspace membership together (unifying login identity and work identity by construction); the UI-only first-run wizard and governance tour; and minting a first agent token as a deliberate, separate, manual step. |

## Regeneration rule — never hand-edit the HTML

Every diagram here is generated output. **Do not edit these `.html` files directly** — any manual fix will be
silently lost the next time the diagram is regenerated, and hand-placed SVG coordinates reintroduce the overlap
bugs the generator exists to prevent.

To change a diagram:

1. Edit its flow spec in the external diagram engine used to render these flows (not part of this repo)
   (the six new specs are `nopm-change-request-lifecycle`, `nopm-project-lock-rebaseline`,
   `nopm-period-close-reopen`, `nopm-agent-token-lifecycle`, `nopm-document-control`, and
   `nopm-invite-onboarding`; the original two are `nopm-four-eyes-deletion` and `nopm-timesheet-lifecycle`).
2. From the engine directory, run:
   ```
   node generate.mjs specs/<slug>.flow.mjs <slug>.flow.html
   ```
   The script recomputes every coordinate from named layout constants and runs a collision self-check before
   emitting — it prints `Collision self-check: 0 overlaps, 0 proximity violations` or throws with the exact
   offending node pair. A `branches[].fromGateId` **must** reference a node of `kind: 'gate'** — pointing it at
   a plain `step` node silently produces `NaN` coordinates that pass the collision check but throw SVG rendering
   errors in the browser, so always browser-verify after generating.
3. Copy the freshly generated `<slug>.flow.html` from the engine directory into `docs/processes/` under this
   repo's naming convention (`<slug-without-nopm-prefix>-flow.html`), and update this README's description if
   the diagram's coverage changed.

See `ENGINE.md` and `svg-kit.md` in the engine directory for the full FLOW SPEC schema and the gold-standard
visual tokens (teal `#0f766e` accent, amber gates, the mail/bell/diamond legend).

## Provenance

All eight diagrams are dated **2026-09-07** and reverse-engineered directly from the live NoPM codebase — route
paths, RPC and migration names are cited in each diagram's own notes and prose panels rather than repeated here.
Two confirmed-absence findings (change requests have no auto-apply effect; documents have no four-eyes approval)
are called out in-diagram rather than fabricated, per the same standard applied to every other flow.
