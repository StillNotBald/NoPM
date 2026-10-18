# UC-24 · Link a Lark account to a NoPM profile

**Goal:** Tie one Lark or Feishu account to one NoPM profile, proven by a one-time code the person generates while signed in, so that card clicks are attributed to the right human. Accounts are never matched by email address.

**Actors:** Member (any signed-in member; generates the code and messages the bot). Admin (reviews every link in the workspace and can remove any of them). Hub (mints the code, verifies the bot event and writes the link). Lark (delivers the bot message with the verified sender identifiers).

**Preconditions:**
- The workspace has an active Lark connector, created by an admin.
- The member is signed in to NoPM and can send a direct message to the bot in Lark.
- The member has no active link on this connector, and the Lark account is not already linked to another profile on it.

**Trigger:** A member wants their approval cards to reach them, or an admin asks them to link.

## Main flow

1. **Mint the code.** The member calls `POST /api/integrations/identities/link-code`. The hub returns a code in the form `NPL-XXXX-XXXX`, valid for 10 minutes and usable once. Only a hash is stored (`identity_link_codes`). The code is shown once. The mint is audited as `integration.identity.code`.
2. **Send it to the bot.** The member sends the bot a direct message: `link NPL-XXXX-XXXX`.
3. **Verify the sender.** The platform delivers the message to the hub, either through the webhook or through the self-hosted worker. The hub verifies the event. The sender's identifiers (`open_id` and `tenant_key`) come from the verified event, never from the message text.
4. **Consume the code.** The hub hashes the submitted code, finds an unused, unexpired code on this connector, marks it used, and creates an active identity that links this Lark account to the code owner's profile.
5. **Confirm.** The bot replies with a link-confirmation card.
6. **Audit.** The link is audited as `integration.identity.link`, with the code owner as the actor, `channel='lark'`, and the Lark message id (the id the bot message is de-duplicated on).

## Alternate and exception flows

- **Code expired (more than 10 minutes old).** The bot replies "Code expired". No link is made. The member mints a new code.
- **Code already used, or unknown.** The bot gives its own card for each case ("Code already used", "Code not recognised"). While the connector is paused, minting a code is refused: `422` `connector_paused` ("The Lark connection is paused. Ask an admin to resume it.").
- **Lark account already linked to another profile on this connector.** Refused by the one-active-link rule. The existing link must be removed first, by its owner or an admin.
- **Profile already linked on this connector through another Lark account.** Refused by the one-active-link-per-profile rule: a code never replaces an existing link, so a leaked code cannot re-point someone's approvals. The bot answers "This NoPM account is already linked to another Lark account. Unlink it in NoPM (Integrations) first, then send a new code." The code is spent and the refusal is audited as `integration.identity.link.blocked` (code owner as actor, ids masked). The member removes the old link, mints a new code and sends it from the new account.
- **Connector paused or revoked.** v1: the bot does not link, and the code stays unused until it expires.
- **Message that is not a command.** The bot replies with its help card, which lists `help`, `link <code>` and `approvals`.
- **Unlink.** The member, or an admin, calls `DELETE /api/integrations/identities/[id]`. The link is removed and audited as `integration.identity.unlink`. Later card clicks from that Lark account are refused as not linked. If the connector is revoked, its links are revoked with it.

## Postconditions

- At most one active link per Lark user on a connector, and at most one active link per profile on a connector.
- The code row records when it was used. No plaintext code is stored.
- Audit rows: `integration.identity.code` for the mint (with the channel of the request that made it), `integration.identity.link` for the bot-side link (`channel='lark'`), `integration.identity.link.blocked` for a refused attempt, and `integration.identity.unlink` when a link is removed. The Lark ids in them (the audit stream and `audit_log.external_actor_ref` are member-readable) are masked.
- Linking grants no scope. The linked person's approvals still follow their role and scopes.
- Card clicks from the linked account resolve to this profile as the principal (ADR 0013).

## Reporting and evidence

- `GET /api/integrations/identities` lists the caller's own links. An admin sees every link in the workspace.
- The Trust Center `channel` filter set to `lark` shows link events.

## Traceability

- R-IDs: TBD.
- Key files (planned, per PLAN W3a and W3b): `web/src/lib/integrations/identity.ts`, `web/src/app/api/integrations/identities/**`, and the inbound verification code under `web/src/lib/integrations/lark/`.
- Related ADRs: 0012 (identity linking by one-time code), 0013 (principal).
- Related use cases: UC-23 (uses the link), UC-19 (invite and onboarding, the pattern this code flow follows).
- Tests: TBD.

## Open questions

- The research behind this design recommended MFA where a member has it enrolled. PLAN has no such step, so v1 proves possession of the code only. Owner decision: should linking require MFA where enrolled?
- The exact wording of the bot's replies (expired, unknown, already linked) is not fixed in PLAN.
