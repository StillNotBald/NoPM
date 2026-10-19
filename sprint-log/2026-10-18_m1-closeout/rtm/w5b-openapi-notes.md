# OpenAPI and llms.txt wording - W5-B (atomic security and integration writes)

Apply in `web/src/app/api/openapi.json/route.ts` and `web/src/app/llms.txt/route.ts` during the docs pass. No request or response shape changes; this is wording only.

## Two-step sign-in (`POST /api/auth/mfa/enroll`, `/verify`, `/challenge`, `/disable`)

- Add one sentence to each: "The change to the two-step record and its audit row are written in one database transaction: if the audit row cannot be written, the change is not kept and the call answers 500."
- `POST /api/auth/mfa/challenge` and `/verify` and `/disable`: add "Attempts count against the account's budget before the code is checked, and a code's 30-second step is used up on success; neither is undone when the audit write fails, so a failing audit never gives a free guess."
- `POST /api/auth/mfa/challenge`: "A backup code is spent in the same transaction as the audit row. Two requests with the same backup code cannot both pass: the second is refused and audited as `auth.mfa.challenge_failed`."
- `POST /api/auth/mfa/verify`: "The backup codes are returned once. The server keeps only their hashes and they never appear in an audit row."

## Connectors

- `POST /api/integrations/connectors`, `PATCH /api/integrations/connectors/{id}`, `POST`, `PATCH` and `DELETE /api/integrations/github/connector`: "The change and its audit row are one transaction; no connector exists without its audit row. The audit row holds the masked public view (platform ids shortened, tenant as a flag, secrets as present or absent) and never a secret value, a ciphertext or a hash."
- `PATCH /api/integrations/github/connector`: "When a request changes both the connector (status, rotate_secret) and the event rules, both are saved together with both audit rows (`integration.connector.update` and `work_event_rules.update`) or neither is."

## Accepting an invite, linking a chat account

- `POST /api/invites/accept`: "The other open invites for the same e-mail are revoked together with one `invite.revoked` row each, in one transaction."
- Lark account linking (link code sent to the bot; see the Lark section): "Using a link code burns the code, replaces the person's earlier link, adds the new one, pins the Lark tenant (first link by an admin or manager) and writes `integration.identity.link` in one transaction. If any part fails the code stays unused. A person who already has a link is refused: the code is spent and `integration.identity.link.blocked` is recorded."

## Audit actions (Trust Center and `GET /api/audit` wording)

- `mfa.enroll_started`, `mfa.enabled`, `mfa.disabled`, `auth.mfa.challenge_passed`, `auth.mfa.challenge_failed`, `auth.mfa.verify_failed`, `auth.mfa.disable_failed`, `integration.connector.create`, `integration.connector.update`, `integration.connector.revoke`, `work_event_rules.update`, `invite.revoked`, `integration.identity.link`, `integration.identity.link.blocked`, `assistant.token.mint`, `assistant.token.revoke`: "Written in the same transaction as the change they describe."

## llms.txt

- Under the audit paragraph: one line, "Two-step sign-in changes, connector changes, the assistant's short-lived tokens, the invite sweep and chat-account links are audited in the same transaction as the change; none of them exists without its audit row."
