# ADR 0020 - Telegram connector (chat bot over the integration hub)

- **Status:** Proposed. The maintainer asked for a Telegram bot on 2026-11-03. That request is her go-ahead for the three constitutional items below (a new connector kind, a new table, a new audit channel); she confirms them by merging this ADR with the branch.
- **Date:** 2026-11-03
- **Builds on:** ADR 0012 (integration hub fan-out), ADR 0004 (BYOK assistant), ADR 0018 (atomic audit), ADR 0019 (module registry)
- **Outcome served:** easier reporting (digest, status) and presentable multi-project (project status card).

## Context

The hub (ADR 0012) fans events out to one chat platform (Lark) and accepts exactly one inbound mutation: a human, identity-verified approve or reject. Telegram is a second chat channel. Unlike Lark it has no tenant, no card JSON and no SDK we need, and a serverless host has no shared memory, so a multi-step chat ("add a task", then "confirm") needs durable state.

## Decision

1. **New connector kind `telegram`.** `integration_connectors.kind` accepts `'telegram'` (the CHECK is widened). One live connector per workspace, as for Lark. The bot token and a per-connector webhook secret are stored in the existing AES-256-GCM `secret_enc` blob (token in the first slot, webhook secret in the second), never returned by any API, never logged. The connector id is the "tenant" of every identity link.
2. **Plain `fetch` client, no new dependency.** Six Bot API methods (sendMessage, editMessageText, answerCallbackQuery, setWebhook, setMyCommands, deleteMyCommands), each with a timeout; the bot token is redacted from every error. A framework such as grammY stays an option only with the maintainer's later approval.
3. **Webhook secret token per connector.** `setWebhook` registers a random secret; the route compares `X-Telegram-Bot-Api-Secret-Token` in constant time and answers one generic 401 otherwise. The route answers 200 at once and does the work after the response.
4. **Private chats only.** Group, supergroup and channel updates are ignored without a reply. A linked account is required for everything except help and linking.
5. **One-time link codes.** The user mints a code in NoPM (the existing identity link code: 10 minutes, one live code per user, a new code replaces the old one) and sends `/start CODE` (or types the code). The existing attempt limit applies (8 wrong tries per sender per 10 minutes pause linking for that Telegram user). A linked member must unlink before linking another account. Disconnecting the bot erases the token and unlinks all chats.
6. **Durable pending state with compare-and-swap.** New table `chat_pending` (workspace, connector, chat, kind, payload json, `version`, `status`, `expires_at`) holds an open ask, preview or pick list. Update-id dedupe is a row of kind `seen` with a unique `(connector_id, dedupe_key)`. A confirm tap claims its row with a compare-and-swap on `version`; the second tap of a double tap loses the swap and is silently ignored. Expiry is lazy (checked on the next message): asks 2 minutes, previews and confirms 10 minutes. No timers, no push on expiry. Pending rows are kept while the connector is only disabled.
7. **`callback_data` of at most 64 bytes.** A button carries only `<verb>:<pending id>[:<index>]`; the action lives in the pending row.
8. **New audit channel `telegram`.** Writes made from chat are audited with `channel = 'telegram'`. The audit_log CHECK, and the channel allow-lists inside the audited SQL functions, are widened. The channel is derived by the server from the per-action token kind, never from a header the caller chooses.
9. **Writes go through the REST API with a per-action scoped token.** Each write mints one short-lived token (kind `telegram`, `created_by` = the linked human, scopes limited to that action, never an approve or admin scope), calls the documented route, then revokes the token. So every write gets exactly one audit row from the route, four-eyes compares people not tokens, and the bot holds no service-role write path. If the audit write fails, the action fails with it (atomic with the mutation, ADR 0018). A revoked or expired token fails the pending write; the user hears on their next message, with no push.
10. **Deletes are request-only.** The bot can raise a deletion request (maker-checker) and never approve one it raised. In `/4 Approvals` a requester who taps Approve or Reject on their own request is refused and the request stays pending. Approving goes through the existing decision path used by the Lark card.
11. **Numbered menu, digits as commands.** `/1` My work, `/2` Add, `/3` Update task, `/4` Approvals, `/5` Project status, `/6` Digest, `/0` help (`/0 all` lists everything). Hidden words still work when typed. The registered menu is role aware: the default scope is the member menu, and an admin or manager gets a per-chat scope after linking. A viewer sees read-only items. A project the user cannot access gets "no access" and the reply does not confirm the project exists.
12. **No bundled LLM.** Free text goes to `askAssistant(actor, text)`, a seam that today returns a fixed message pointing the user at their own model key (BYOK, ADR 0004). Wiring it to the shared assistant engine is a later change; the Telegram path must never mint an approve scope.
13. **Additive only.** Lark code, snapshots and behaviour are untouched. The new routes live under `/api/integrations/telegram/`, inside the existing `integrations` module of the registry, so `NOPM_MODULES` switches them off with the rest.

## Defaults chosen (the maintainer was asleep)

English copy only (one table, keyed for later languages); no polling mode; no group support; no expiry push; a disabled connector answers "This connector is turned off"; per-user rate limiting through the shared `nopm_rate_check` counter; 256 KB body cap; update bodies are never logged.

## Consequences

- A new table, a new connector kind and a new audit channel enter the schema. All are additive; nothing existing is rewritten except widened CHECKs and the channel allow-lists in audited SQL functions.
- The allow-list widening is done by a generated `create or replace` of each function that names the lark/github channels; it has not been run against a database and must be rehearsed before release.
- Bot tokens are bearer secrets. Rotation is a paste of a new token; a leaked token is revoked at BotFather.

## Not in this ADR

Settings card UI, wiring of the shared assistant engine for free text, push notifications (approval cards, digest delivery adapter) and live setup against the real Telegram API.
