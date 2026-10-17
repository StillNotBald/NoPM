# ADR 0012 — Integration hub: fan-out boundary and the inbound approval path

- **Status:** Accepted (owner, 2026-10-16)
- **Date:** 2026-10-16

## Context

NoPM's integration surface is pull-only. An agent can read the audit cursor, call the REST API or the MCP server, and use the CLI. Nothing pushes an event out, and nothing accepts a click back in. A person who needs to approve a change request has to open the console to do it.

Chat approval cards would close that gap: an approval request lands in the approver's Lark direct message with Approve and Reject buttons. The wider plan, including the decisions this ADR records (D1–D10), is in `sprint-log/2026-10-16_lark-integration/PLAN.md`. Three things make a chat button a governance question, not only a plumbing question:

1. **Inbound mutation.** A button click is a state change that arrives from a third party's servers. Without a fixed boundary, every connector becomes a possible route around the scopes, lock checks, maker-checker and audit that the data layer enforces.
2. **Identity.** A click is attributed to a chat account, not to a NoPM user. That mapping must be verified, and the four-eyes check must compare the accountable human, not whichever actor carried the request (ADR 0013).
3. **Scope creep.** Once events can fan out and clicks can mutate, the pull toward conditions, chaining and templates is strong. Automations engines are on the ask-first list in `CLAUDE.md`, and the hub must not become one by accretion.

This ADR records where the boundary sits, the three structural limits that keep the hub from becoming an automations engine, and the alternatives that were rejected.

## Decision

1. **The hub is a fan-out of fixed message kinds to fixed recipients.** In v1 the hub sends an approval-request card to each eligible approver, a decision-update patch to cards already sent, a weekly digest to one configured group chat (plus an admin "send now"), and short bot replies. The hub resolves recipients from governed state. There is no subscription table, no per-message routing and no per-user message configuration.

2. **The only inbound mutation is a human approve or reject on an existing request.** A chat action may decide one pending deletion request (task or project), change request or timesheet submission. It must pass these checks in order:
   - the platform identity is verified and linked to an active NoPM profile;
   - a single-use action token, bound to that profile and that request, is consumed atomically;
   - the decision runs through the same per-kind decision code the REST routes call;
   - the existing scope, lock and four-eyes checks run unchanged.

   Chat has no shortcut around any of them.

3. **Adapters are pure translation.** A platform adapter renders NoPM's fixed messages into the platform's format, sends and patches them through the platform SDK, and verifies and parses inbound payloads into a platform-neutral action. It makes no governance decisions and reads and writes no NoPM tables. The hub core owns identity, tokens, idempotency, retries and the decision call.

4. **Lark first, two transports, one handler.** A hosted instance receives Lark webhooks on Vercel routes. A self-hosted instance runs one long-connection worker (`web/scripts/lark-worker.mjs`), which relays each event to the app over an HMAC-signed local request. Both transports call the same handler. Only one worker may listen per app, because the platform delivers each event to one connection chosen at random.

5. **Scheduler: Vercel Cron, once a day.** `GET /api/integrations/cron` (`7 1 * * *`, 01:07 UTC, off the hour and half-hour because the platform sheds load then), guarded by a constant-time check of `CRON_SECRET`, retries pending deliveries, sends the weekly digest on its configured weekday and prunes old bookkeeping rows. The first attempt at a new card runs right after the response, not on the cron. The tick is built to finish inside its time limit (see "Reliability properties").

6. **Identity is linked by a one-time code**, minted by a signed-in member and sent to the bot. Linking is never done by matching email addresses.

7. **Dependencies.** The official Lark SDK (`@larksuiteoapi/node-sdk`, MIT) is pinned to exactly `1.74.0`. Request signing, payload decryption and calendar output use `node:crypto` and hand-written code. No other dependency is added.

## The three structural limits

These keep fan-out from turning into an automations engine. They are the review criteria for any change to the hub. A change that breaks one needs a new ADR, not a routine feature pull request.

1. **No conditions.** A route selects by message kind and by connector. There are no expressions, field predicates or AND/OR combinations.
2. **No message causes a mutation except a human decision.** No "when X, then create or assign", no chaining (a decision does not trigger another message that decides something), and no scheduled mutation. The cron sends messages and retries deliveries; it never calls a decision function.
3. **No user-defined transforms or templates.** Card layouts and digest content are built in the repository. A connector's settings hold its name, region, digest weekday and group chat. They do not hold message text or code.

## Consequences

- Chat approvals inherit every console guarantee: scopes, lock checks, four-eyes (ADR 0013) and the single decision code. A defect in that code now affects every channel at once. That is the intended trade for having one governed path.
- The server sets `channel='lark'` from the connector binding. The `X-NoPM-Client` header is ignored on connector routes. `audit_log` gains the `lark` channel value and three nullable columns (`via_connector_id`, `external_event_id`, `external_actor_ref`). The change is additive: no trigger, policy or immutability change.
- A chat decision is attributed to the linked profile, and its audit row carries the Lark event id, so the external action can be traced back to its source.
- **Retries follow the backoff ladder only while the workspace has traffic; the daily tick is the floor.** The delivery schedule is 1 minute, 5 minutes, 30 minutes, 2 hours, 12 hours, then dead. After every approval event the same invocation also drains up to 10 due retries for that workspace, so a busy workspace retries on the ladder. A quiet workspace has nothing to trigger a drain, so a failed send there waits for the next daily tick: the worst case is one tick (about a day) per attempt, not the ladder interval. A sub-daily tick would close that gap and is an infrastructure decision for the owner; this ADR does not settle it.
- **Open verification: self-hosted approval buttons.** Lark's documentation confirms that card-button callbacks arrive by webhook. It does not confirm that they also arrive over the long connection. Until a spike proves it, self-hosted approval buttons are unverified. Hosted instances use the documented webhook path.
- Lark (international) and Feishu (China) are separate platforms. The region is stored per connector and selects the SDK domain.
- One active Lark connector per workspace (partial unique index). Connectors stay per instance. There is no cross-workspace identity.

## Reliability properties

Chat delivery is best-effort and never blocks a governed write, so the guarantees below are about what a failure or a race cannot do, not about delivery being certain. They came out of a reliability review of the first build and are enforced in `src/lib/integrations/` (migrations `20261017000051_hub_reliability.sql` and `20261017000053_hub_card_integrity.sql`).

- **One delivery, one card, one token.** Each queued card has an action token derived from its delivery id under the server's encryption key (HMAC; only the SHA-256 is stored, as before). A retry recomputes the same token instead of minting another, and the delivery id is also the platform's message `uuid` (its one-hour de-duplication key). A send that landed but whose response was lost therefore returns the original message on retry instead of creating a second card, and a card that never reached the platform leaves one unused token, not one per attempt. Residual: the platform only de-duplicates for an hour, so a retry after the 2-hour and 12-hour steps of the ladder can still repeat a card whose earlier attempt was ambiguous.
- **No card for a request that is no longer pending.** Before a token is minted the delivery re-reads the request (one workspace-filtered primary-key read) and is superseded if the request was decided or removed. A request decided while its card is in flight is reconciled when the send settles: any token minted after the decision's kill pass is killed, and the queued card patch runs at once rather than at the next drain. A click on a stale card was already harmless (the decision code re-checks state); this closes the live-looking-buttons window.
- **Leases follow the clock.** A claim lease is measured from the moment of the claim, not from when the drain began, and is renewed (compare-and-set) immediately before each platform call; a drain that no longer owns the row does not send. A drain longer than the lease can no longer double-send.
- **The scheduler finishes.** The tick queues every connector's digest first (database work only), then drains connectors with bounded concurrency, oldest backlog first, and stops starting work at 40 seconds of a 60 second limit. An overrunning connector job is abandoned, not awaited, and whatever was not reached stays queued for the next tick. Every platform call has a 10 second timeout, enforced by aborting the request, not only by no longer waiting for it.
- **The weekly digest is claimed atomically.** One scheduled digest per connector per ISO week is a unique index; the winner audits, then fills and releases the row. A tick killed in between leaves a held row that the next tick resumes, and a digest day a tick missed entirely is made up the next day when the schedule predates that day. Switching the digest on, or changing its weekday, after the day has passed is never made up.
- **Retention.** The daily tick deletes terminal deliveries older than 60 days (their tokens go with them), action tokens 14 days after they expire and completed inbound idempotency rows older than 90 days, in bounded batches per workspace. `audit_log` is never touched.
- **Operator visibility.** The admin connector view carries a `health` block (queue counts by status, dead letters, last send, last failure text, last scheduler run). A scheduler that never runs, for example because `CRON_SECRET` is unset, is logged as such.
- **Calendar feed.** The ICS feed covers milestones from 90 days back, in date order, paged under a 2,000-event cap that is reported (`X-NoPM-Feed-Truncated`), not silent. It carries an ETag and answers `If-None-Match` with a 304, and it is throttled per client address and per feed because the route is public.
- **A card can only approve what it showed.** A card is a snapshot with a seven-day life, but the request behind it can be edited. Each action token is bound to the request's content version at mint time (the row's `updated_at`; change requests and timesheets, since deletions cannot be edited). Taking the action re-reads the request: a different version is refused with the outcome `changed`, nothing is decided, and the same version pins the decision write itself (a 412 from it is also `changed`), so an edit landing between the check and the write cannot be approved unseen. An edit that matters to an approver calls `emitApprovalChanged`: the old tokens are retired as `changed`, the old cards are patched to "Updated, see the new card", and approvers get fresh cards with the current content. A refused tap re-issues the cards itself, so an edit that changed nothing material (a save with no changes) is never a dead end.
- **Link codes are guarded.** A code is a 40-bit bearer secret, so attempts are limited per sender and per connector (a 10 minute window; the keys hold a hash, never a platform id). When a code replaces a person's existing link, NoPM records an in-app notice for that person and the old Lark account is told by DM. Only an admin's or manager's first link pins the connector to a Lark tenant, so a viewer cannot lock the real tenant out by linking from a foreign one.
- **No oracle before authentication.** For the webhook and relay URLs an unknown, paused or revoked connector gets the same answer as a failed check (a generic 401), after the same work. Failures are counted per trustworthy client network (never a header the caller wrote, IPv6 collapsed to its /64) and per connector, and good requests are never counted per address because the platform's own servers carry every tenant's traffic. A connector that cannot decrypt its own secrets answers a generic 503. Each connector has its own tenant-token cache, so a wrong secret can never ride another workspace's token.
- **Webhook mode requires an Encrypt Key.** Without it the verification token (in clear text in every event, visible to every collaborator on the Lark app) is the only proof an event came from Lark. Long-connection mode exposes no public URL and may omit it.
- **Audit privacy.** Connector and identity audit rows hold masked ids (app id, group chat id, tenant, open id) and only a `tenant_pinned` flag, because the audit stream is readable by every member. The unmasked reference stays in the `external_actor_ref` column of a chat-originated action, so that action remains traceable.
- **Card budget.** An approver gets at most 20 approval cards an hour; beyond that one roll-up message ("N approvals are waiting") replaces more cards, so one low-privilege token cannot flood a person's chat.
- **Known limits.** The digest weekday is evaluated in UTC with no per-workspace time zone. The ISO week turns over at Monday 00:00 UTC, so a digest sent on Sunday and a digest rescheduled to Monday can go out within a day of each other. A key change (`NOPM_ENCRYPTION_KEY`) makes stored connector credentials unreadable and derives different tokens for cards not yet sent; reconnect the app after rotating it.

## Why this respects the constitution

- **No bundled LLM.** Nothing in the hub calls a model. An approver's identity comes from their own button press, so an agent cannot approve on a person's behalf through the chat path.
- **Governance stays in the data and API layer.** The hub calls the existing decision code; it does not reimplement the rules.
- **Audit immutability.** The only change to `audit_log` is additive.
- **Ask-first items.** The items on the ask-first list that this design touches (chat approval, the audit channel extension, the scheduler and the Lark SDK) are covered by the owner's 2026-10-16 instruction to build Lark first and use open source where possible. Each is listed as a decision in the PLAN.

## Alternatives considered

- **Lark's native Approval as the system of record.** Rejected for v1. Lark would hold the decision state, so NoPM's scopes, lock checks and audit would no longer decide the outcome, and the decision would need to be mirrored back. Four-eyes stays in NoPM; Lark only renders the card and relays the click. The vendor's third-party approval integration is phase 2, which the vendor itself estimates at two to four weeks.
- **An agent that approves through a Lark MCP tool on a person's behalf.** Rejected. The approver's identity must come from the person's own button press, and an agent cannot supply it.
- **An audit-table trigger outbox (every audit row becomes an event).** Deferred to the generic webhook wave. It would make every governed write a potential outbound message before a message registry, payload rules and recipient rules exist, and it would attach a trigger to the most sensitive table for a feature that does not need it yet.
- **Email-match identity linking.** Rejected. Email is not a verified claim on every platform, and a match can attach a chat account to the wrong profile. A one-time code proves possession from both sides.
- **A generic subscription engine.** Rejected. Per-user routing with conditions is the automations engine the constitution puts on the ask-first list.
- **Separate route trees per platform.** Rejected. Each tree would duplicate identity, idempotency and token handling, which is where the governance risk sits. One shared core with thin adapters keeps that logic in one place.

## Related

- ADR 0006 (atomic deletion commit), ADR 0007 (MCP surface), ADR 0013 (principal-aware four-eyes).
- UC-23 (approve or reject from Lark), UC-24 (link a Lark account), UC-25 (weekly digest), UC-26 (calendar feed subscription).
