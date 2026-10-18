# UC-23 · Approve or reject a governed request from Lark

**Goal:** Let a linked approver decide a pending deletion or change request from a Lark card, under the same rules as the console: the same decision code, the same four-eyes check, and audit rows that record the chat channel.

**Actors:** Approver (a linked, active member with the admin or manager role, who is not the requester's principal). Requester (raised the request; does not receive its card). Hub (sends and patches cards, resolves the click and calls the decision code; it never decides on its own). Lark (delivers the button click and the card callback).

**Preconditions:**
- The workspace has one active Lark connector with its credentials stored.
- The approver has an active identity link on that connector (UC-24).
- The request is still open: `pending` for a deletion request, `raised` or `under_review` for a change request.
- The approver's role and scopes allow the decision. The card is sent only to admins and managers, but the decision code checks scopes again at click time.

**Trigger:** A deletion request or change request is created, which sends the card. Or an approver taps Approve or Reject on a card they already have.

## Main flow

1. **Card sent.** The request is created in the console, API, CLI or MCP, and its audit row is written as usual. After the response, the hub resolves the eligible approvers: linked, active, admin or manager, and not the requester's principal. For each one it mints a single-use action token (7-day expiry, bound to that profile and that request), stores a `pending` delivery, and sends an approval card with the request title, project, requester, a summary, a link to the request, and Approve and Reject buttons.
2. **Approve tapped.** Lark posts the click to the hub's card callback. The hub verifies the callback and records the Lark event id. A repeat of the same event id returns the stored outcome. The hub then maps the Lark user to the linked profile.
3. **Token consumed.** The hub consumes the action token in one step. It must be unused, unexpired, and bound to this profile and this request. The actor is then built as a user actor whose principal is the profile, with `channel` set to `lark` and the connector and event ids attached.
4. **Decision made.** The hub calls the decision code for the request's kind. Approve on a deletion runs the atomic commit (ADR 0006). Approve on a change request sets the decided status. The Approve button has no input, so the approve note is the kind's default.
5. **Answer within three seconds.** The callback responds with a toast ("Approved") and a replacement card showing the decided state: who decided, through which channel, and when. The replacement card has no buttons.
6. **Other cards updated.** Every other card already sent for this request is patched to the decided state, and the request's remaining open tokens are superseded.

**Reject tapped.** Reject opens a form with a required reason. Step 4 then records the reason in the note or rationale field for that kind. The form does not submit without a reason. If an empty reason reaches the hub anyway, the decision code refuses it and the approver sees an error toast.

## Alternate and exception flows

- **Self-approval (the approver is the requester's principal).** Refused with a toast, and nothing changes. The requester is excluded from recipients, so this path should not occur through cards. The check stays in place because ADR 0013 requires the decision code to refuse it however the click arrived.
- **Account not linked.** The hub replies that the Lark account is not linked to NoPM and points to the link flow (UC-24). Nothing changes. v1: the wording is set by the adapter; PLAN does not fix it.
- **Expired action token.** Tokens last 7 days, and a card can be tapped after that. The approver sees an "expired" toast and nothing changes. v1: this path does not re-render the card; PLAN does not say whether it should.
- **Token held by someone else.** A card forwarded to another person, or a token bound to a different approver, is refused as "not the recipient". The token is not consumed.
- **Already decided elsewhere.** The request was decided in the console, through the API, or on another card. The tapped card shows a toast that the request is already decided, and it is patched to the decided state with the deciding person and channel.
- **Locked project (deletion).** The commit refuses a locked project with the same refusal the console shows. The deletion stays pending.
- **Scope missing or viewer role at click time.** The decision code returns forbidden. The approver sees a toast and nothing changes. This happens only if the approver's role changed after the card was sent.
- **Replayed callback.** A double tap or a Lark retry carries the same event id. The stored outcome is returned, with no second mutation and no second audit row.
- **Second tap with a new event id.** The token is already used, so the request is refused. Whether the approver sees "already decided" or "expired" depends on the order of checks, which PLAN does not fix.
- **Paused or revoked connector.** v1: a paused or revoked connector accepts no clicks. The approver sees an error toast and nothing changes. Revoking a connector also revokes its identity links (UC-24).
- **Callback fails verification.** The request is rejected before anything is read or changed.
- **Decision error.** The approver sees a typed error toast. A deletion approval is one transaction (ADR 0006), and a change request decision is a compare-and-set on status, so a failure leaves the request open rather than half-decided.

## Postconditions

- The decision has the same result as the same decision made in the console: the same status change, the same scope and lock checks, the same four-eyes rule, and (since decision 16) the same admin-or-manager role rule. In chat the role is checked before any action token is consumed.
- Audit: every row written by the decision carries `channel='lark'`, the connector id, the Lark event id and the external actor reference. The counts follow the console path. A deletion approval writes two rows in one transaction, the entity delete and `deletion_request.approved` (UC-12). A deletion rejection writes `deletion_request.rejected`. A change request decision writes `change_request.decide`.
- The request leaves the approvals queue and the Review Queue.
- Every card sent for the request shows the decided state, and no live buttons remain.
- The inbound action record holds one entry per Lark event id, with its outcome.

## Reporting and evidence

- The Trust Center `channel` filter set to `lark` lists these decisions. The object's history shows the linked profile as the actor.
- `GET /api/audit?channel=lark` returns the same rows through the audit cursor, in order.

## Update 2026-10-17 — journey-audit fixes

- Owner decision 16 ("follow Lark rules", ADR 0014, R-113): approving or deciding is for admins and managers only, on every channel. A member or viewer gets `403` `role_not_permitted` ("Only managers and admins can approve"). A token is judged by the CURRENT role of the person who minted it, so a member cannot approve through a token and a demoted manager's token stops approving at once. Chat already worked this way ("Only managers and admins can approve or reject from chat."); the web now matches it.
- **A refused self-approval keeps the card usable.** If the requester taps their own card, the click is refused and the card stays live for the real approvers.
- **Catch-up on resume.** When a paused connector is resumed, approval cards for requests that are still pending are sent (deduplicated), so approvers no longer miss requests raised while it was paused.
- **Atomic revoke.** Revoking a connector is one transaction (links, queued messages and the audit row together). While a connector is paused, `link-code` answers `422` `connector_paused` ("The Lark connection is paused. Ask an admin to resume it.").

## Update 2026-10-18 - common-pattern answers

- Lark cards now cover rebaseline sign-off: approve records a `go`, reject a `no_go` with a reason. The bot approvals list includes rebaselines. Defer and withdraw stay on the web.
- An admin can list failed messages (`GET /api/integrations/connectors/{id}/deliveries?status=dead|retry`) and retry one (`POST .../deliveries/{deliveryId}/retry`; audit `integration.delivery.retry`).
- Dates and the weekly digest follow the workspace time zone (`GET/PATCH /api/workspace-settings`, default Asia/Kuala_Lumpur).

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

## Traceability

- R-IDs: TBD.
- Key files (planned, per PLAN W3a and W3b): `web/src/lib/governance/decide.ts` (shared decision code), `web/src/lib/integrations/inbound.ts` (inbound pipeline), `web/src/app/api/integrations/lark/[connectorId]/card/route.ts` (callback), `web/src/lib/integrations/lark/cards.ts` (card builders).
- Related ADRs: 0012 (hub boundary and inbound path), 0013 (principal-aware four-eyes), 0006 (atomic deletion).
- Related use cases: UC-08, UC-10, UC-12, UC-24, UC-25.
- Tests: TBD.

## Open questions

- `[UNVERIFIED]` Whether card-button callbacks arrive over the long connection for self-hosted instances. A spike must confirm this before the self-hosted approval path is claimed (ADR 0012).
- Card patching: the vendor's patch API is documented for shared cards within a time window. PLAN does not set the card configuration. Confirm that decided-state patches reach every card sent.
- Resolved 2026-10-17 (decision 16, ADR 0014): admin or manager is now the rule on every channel, not only in chat. The console, REST, CLI and MCP refuse a member or viewer with `role_not_permitted`, so chat no longer differs from the web. A manager still needs the exact approve scope on a token; a chat click uses the linked user's role.
- Toast and replacement-card wording, and whether the expired, already-used and not-recipient paths also replace the card. PLAN is silent on all of them.
