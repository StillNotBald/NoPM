# Sprint — Wave 5: Change-control register + Decision log (2026-06-09)

**Intent:** add the two PMO governance registers greenlit as v1 MVP — a **change-control register** with a four-eyes decision workflow, and a **decision log** with a supersedes chain. Built by a 2-agent AI-assisted wave (cc-data · cc-ui) + verify; integrated (Review Queue + nav + a second human member) by hand.

## Done
- **Change-control register** (`/change-control`, governance nav) — migration `0017`: `change_requests` (category, priority, status raised|under_review|approved|rejected|deferred|implemented, impact_summary/schedule_days/cost, requester + decider, CR-NNN) with a **DB CHECK `cr_maker_checker`** (a decided CR must carry a `decided_by` ≠ `requested_by`) + workspace RLS. API mirrors the risks register: `GET/POST /api/projects/[id]/change-requests`, `GET/PATCH/DELETE /api/change-requests/[id]`, and `POST /api/change-requests/[id]/decision` — the **four-eyes decision** (approve/reject/defer + rationale; 403 if decider == requester, exactly like deletion self-approval), audited `change_request.decide`, notifies the requester. Register table + right-push detail drawer with the decision panel + raise form.
- **Decision log** (`/decisions`, governance nav) — `decisions` table (context / options / decision / rationale / status proposed|accepted|superseded|rejected / `supersedes` self-FK). `GET/POST /api/projects/[id]/decisions`, `GET/PATCH/DELETE /api/decisions/[id]`, audited. Log table + detail drawer (renders the supersedes reference).
- **Review Queue interlock:** extended `lib/review/gather.ts` (+`queue-list.tsx`) with a 6th source — `change_requests` where `status='under_review'` → a new **change** kind (violet group) deep-linking to `/change-control?cr={id}`. A raised change now lands in the one queue alongside approvals, rebaselines, risks, clashes, in-review docs.
- **Second human member** (`seed-members.mjs`): added **Priya Nair (manager)** + **Daniel Okoro (member)** to the demo workspace so four-eyes is real. The seeded under-review CRs are **raised by the member**, so the logged-in admin (Chu Ling) can approve/reject them **live** without tripping self-approval.
- **Seed** (`seed-change-control.mjs`): 8 CRs (CR-001..008; 3 under_review, 3 approved, 1 rejected, 1 raised — all decided rows satisfy the four-eyes CHECK) + 6 decisions (DEC-001..006; one proposed, one superseded, DEC-006 supersedes DEC-001). Fixed two bugs in the agent's seed: wrong column (`full_name` → `display_name`) and requester/approver now role-selected.
- **Nav:** Change Control + Decisions added to the governance section.

## Verification
- `tsc --noEmit` clean · `next build` clean (verify agent fixed a zod v4 `z.enum` param) — built with the integration edits to gather/queue/sidebar on disk · migration `0017` applied to prod DB.
- Seeds ran clean: 2 members, 8 CRs, 6 decisions.
- RTM green: **39 R-IDs** (added R-07 change-control, R-08 decision log) — `npm run rtm:verify`.
- Deployed to stillnotbald.com.

## Open / deferred
- The decision route reuses notification type `approval.approved` (closest in the closed `NotificationType` union); a dedicated `change.decided` type is a minor polish (Wave 6).
- Member logins exist but passwords were randomized (members are for attribution/four-eyes, not interactive login) — can be reset if a second live login is wanted.

## Next
- Wave 6: harden + land — tests for the new governance invariants (change-request four-eyes), RTM/sprint-log finalize, full live journey walk-through.
