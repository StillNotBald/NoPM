# UC-26 · Subscribe a calendar app to milestones

**Goal:** Let a member subscribe a calendar app (Apple, Outlook, Google or Lark) to the workspace's milestones as all-day events, using a revocable secret URL, with no sign-in inside the calendar app.

**Actors:** Member (any non-viewer; creates and revokes their own feeds). Admin (may revoke any feed). Calendar app (fetches the URL on its own schedule and holds the secret). Hub (serves the feed; read-only).

**Preconditions:**
- The member is signed in with a role other than viewer.
- v1: a workspace with no milestones gets a valid calendar with no events.

**Trigger:** A member wants milestones in a calendar app they already use.

## Main flow

1. **Create.** The member calls `POST /api/calendar-feeds` with a name and an optional project. The hub generates a secret of the form `npc_` followed by 32 random bytes in base64url. It stores only the SHA-256 hash and returns the subscription URL once. The create is audited as `calendar_feed.create`.
2. **Subscribe.** The member pastes the URL into the calendar app as a subscription.
3. **Fetch.** The calendar app requests `GET /api/calendar/{token}`, and a trailing `.ics` is accepted. The hub hashes the token, finds an unrevoked feed, and returns `text/calendar`. The feed contains the workspace's milestones, or only the feed's project if one was set. Each milestone is an all-day event with a stable identifier, a sequence number based on its last update, and a link back to the milestone.
4. **Record the fetch.** The hub updates the feed's last-fetched time in the background. Fetches are not audited.
5. **Manage.** The member lists their own feeds with `GET /api/calendar-feeds`.
6. **Revoke.** The feed's owner, or an admin, calls `DELETE /api/calendar-feeds/[id]`. The revoke is audited as `calendar_feed.revoke`.

## Alternate and exception flows

- **Revoked URL.** The next fetch returns `404`. Events the calendar app already imported stay in that calendar until the subscriber removes the subscription. Revocation stops future updates; it does not erase copies.
- **Unknown or mistyped URL.** The hub returns `404`, with no hint about whether the token exists.
- **Viewer tries to create a feed.** `403`.
- **A member tries to revoke someone else's feed.** `403`, unless the member is an admin.
- **Leaked URL.** Calendar apps cannot send an authorization header, so the URL is itself the credential. It is 256-bit, revocable, and served with `Referrer-Policy: no-referrer` and private caching. Anyone who holds the URL can read milestone titles and dates until it is revoked.
- **Milestone changed.** Calendar apps refresh on their own schedule, and the feed allows responses to be cached for up to 15 minutes. A change can take that long, plus the client's refresh interval, to appear.
- **No un-revoke.** A revoked feed cannot be restored. A new feed gets a new URL.
- **No expiry.** v1: a feed has no expiry date. Revocation is the only way to end it.

## Postconditions

- One `calendar_feed.create` row on creation, and one `calendar_feed.revoke` row on revocation.
- The database holds the token hash only. The URL cannot be recovered after creation.
- The feed's last-fetched time is updated on each fetch. There is no per-fetch audit row.
- A revoked feed keeps its row with a revocation time, and its URL returns `404`.

## Reporting and evidence

- `GET /api/calendar-feeds` lists the caller's feeds with name, project, creation time, last-fetched time and revocation status.
- The Trust Center shows the create and revoke events.

## Traceability

- R-IDs: TBD.
- Planned key files: `supabase/migrations/20261016000047_calendar_feeds.sql`, `web/src/lib/calendar/ics.ts`, `web/src/app/api/calendar/[token]/route.ts`, `web/src/app/api/calendar-feeds/**`.
- Related ADRs: 0012 (the feed sits outside the chat fan-out and has no inbound path).
- Decisions: PLAN D10 (ICS calendar feed).
- Tests: TBD.

## Open questions

- v1 filters by workspace, and by project when one is set. It does not check the creator's project access. Should a feed honour that access? PLAN is silent, and the answer matters if some members cannot see every project.
- Whether each named calendar app accepts a subscription URL in this form, Lark included. The research treated this as an assumption. Verify it per client before it is advertised.
- Whether feeds should ever expire. v1 has no expiry.
