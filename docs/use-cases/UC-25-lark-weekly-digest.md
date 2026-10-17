# UC-25 · Weekly digest to a Lark group chat

**Goal:** Give a group chat a read-only weekly summary of the workspace's governed state, sent on a fixed weekday, with an admin-triggered "send now" that produces the same digest.

**Actors:** Admin (sets the connector's digest weekday and group chat, and may send now). Group members (read the digest; they cannot act on it, because it carries links only). Daily scheduler (Vercel Cron calling the hub). Hub (builds and sends the digest).

**Preconditions:**
- An active Lark connector, with its digest weekday (0 to 6) and target group chat set in its configuration.
- The bot has been added to the group chat and is allowed to post there.

**Trigger:** The daily tick runs on the configured weekday and no digest has gone out yet this ISO week. Or an admin presses "send now".

## Main flow

1. **Daily tick.** Vercel Cron calls `GET /api/integrations/cron` with `Authorization: Bearer <CRON_SECRET>` once a day at 01:07 UTC (off the hour and half-hour, when the platform sheds load). The secret is checked in constant time.
2. **Select connectors.** For each active Lark connector whose digest weekday is today, the hub checks its deliveries for a digest already sent in this ISO week. If none exists, a digest is due.
3. **Build.** The hub assembles the digest from the workspace's governed data (`digest-data.ts`). The content is fixed in code. An admin does not write it.
4. **Send.** The hub renders the digest card and sends it to the group chat. It records a `digest` delivery with the outcome and the attempt count.
5. **Send now (optional).** An admin calls `POST /api/integrations/connectors/[id]/digest`. The hub builds and sends the same digest immediately and writes an `integration.digest.send` audit row.

## Alternate and exception flows

- **Paused or revoked connector.** The daily tick skips it. "Send now" is refused with an error.
- **Missing or wrong secret on the cron call.** The call gets `401`, and nothing is sent.
- **The platform refuses the send** (the bot is not in the group, a rate limit, or a server error). The delivery is marked `retry` with a truncated error and retried on a ladder: after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, and after the sixth attempt it is `dead`. The ladder advances whenever the workspace has approval traffic (every approval event also drains up to ten due retries for that workspace); the daily tick is the floor underneath. On a quiet workspace nothing triggers a drain between ticks, so each attempt may wait for the next daily tick (ADR 0012). The send carries the delivery id as the platform's idempotency key, so a retry of a send whose first attempt actually landed cannot post the digest twice.
- **Rate limit.** The platform's reset time is respected. The delivery waits for the next tick.
- **Digest already sent this ISO week.** No second scheduled digest is sent. A changed weekday takes effect on the next tick, but a week that has already been sent is not sent again.
- **Manual send in a week that already had one.** v1: a manual send is an extra message. It does not replace the scheduled digest, so the scheduled one still goes out. PLAN does not say whether a manual send counts toward the weekly guard.
- **Weekday and week boundary.** v1: the weekday and the ISO week are computed in UTC, the timezone the scheduler runs in. PLAN does not name a timezone.

## Postconditions

- At most one scheduled digest per active connector per ISO week.
- Each send leaves a `digest` row in `integration_deliveries` with its status and attempt count, and a truncated error. No secrets are stored.
- A manual send writes one `integration.digest.send` audit row, with the admin as the actor and the channel of the request.
- The digest carries deep links only. It creates no inbound action.

## Reporting and evidence

- Delivery status is kept per send, for support and troubleshooting.
- `integration.digest.send` rows appear in the Trust Center under the admin's name.

## Traceability

- R-IDs: TBD.
- Key files (planned): `web/src/app/api/integrations/cron/route.ts`, `web/src/lib/integrations/cron.ts`, `web/src/lib/integrations/digest-data.ts`, `web/vercel.json`, `web/src/lib/integrations/lark/cards.ts`.
- Related ADRs: 0012 (fixed message kinds and the daily scheduler).
- Related use cases: UC-23 (approval cards on the same connector).
- Decisions: PLAN D6 (daily Vercel Cron) and D9 (moment 4, the weekly digest).
- Tests: TBD.

## Open questions

- **Digest content.** PLAN defines the digest as a fixed message kind but does not list its fields. The research proposed RAG status, milestones due, open risks, budget burn and pending approvals. The owner should confirm the list before the digest builder is written.
- **Group chat field.** PLAN names `digest.weekday` but not the field that holds the group chat identifier.
- **Timezone.** PLAN does not say which timezone defines the weekday and the ISO week. This UC assumes UTC.
- **Manual send and the weekly guard.** Whether a manual send should count toward the once-per-week guard. This UC assumes it does not.
- **Audit for scheduled sends.** PLAN audits the manual send only, but the convention is one audit row per governed mutation. Decide whether a scheduled digest is a mutation that needs its own row.
- **Empty workspace.** Whether the digest still sends, with empty sections, when there is no governed data. PLAN is silent.
- **Retry spacing on a quiet workspace.** Retries follow the 1 minute / 5 minutes / 30 minutes / 2 hours / 12 hours ladder only while the workspace has approval traffic to trigger a drain; otherwise they wait for the daily tick (about a day per attempt). A sub-daily tick would close the gap and is an infrastructure decision for the owner (ADR 0012).
