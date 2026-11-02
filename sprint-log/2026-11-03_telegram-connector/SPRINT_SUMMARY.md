# Sprint summary: Telegram connector

Date: 2026-11-03. Branch `feat/telegram-connector`. ADR 0020 (Proposed): confirm at merge.
Requirements: R-190 to R-197.

## Built
- New connector kind `telegram`, new table `chat_pending`, new audit channel `telegram` (migration `20261103000120_telegram_connector.sql`, written but NOT run).
- `web/src/lib/integrations/telegram/`: plain-fetch Bot API client with token redaction, encrypted secrets (bot token and webhook secret in the existing `secret_enc` blob), numbered role-aware menu, message and button handlers, link flow (`/start CODE`, reusing the identity link code and the 8-attempt limit), per-action scoped token (kind `telegram`, 2-minute TTL, revoked in finally), durable pending store with compare-and-swap, update_id dedupe.
- Routes: `POST /api/integrations/telegram/{id}/webhook` (public, constant-time secret check, 200 fast), `POST .../{id}/setup` (setWebhook and setMyCommands), `GET/POST/PATCH/DELETE /api/integrations/telegram/connector` (admin session). OpenAPI, llms.txt and the module-registry goldens updated.
- Free text goes through the `askAssistant(actor, text)` seam; stub reply only. `web/src/lib/assistant*` untouched.

## Defaults chosen (owner asleep)
- One live Telegram connector per workspace.
- Pending steps expire after a lazy TTL; cancel words exit a step.
- Menu: default scope shows the member menu; admins and managers get a per-chat menu after linking.
- The only approve-type scope ever minted is a single `<target>:delete:approve` scope, alone, when the human taps Approve in /4. The requester can never approve their own request (checked before the CAS).
- Group chats ignored; webhook rate 300/min per connector; failed secrets capped at 30/min.
- Channel is derived server-side from the token kind, never from a caller header.

## Not done
- Settings UI card (no UI in this slice).
- Free-text wiring to the shared assistant engine.
- Live setup: run the migration (rehearse first, it rewrites RPC channel allow-lists), connect a real bot, call setup. The real Telegram API was never called.
- Nothing pushed, no PR.

## Part 2 (2026-11-03): journey alignment and settings UI
Requirements R-198 and R-199. All journey decisions below are PROPOSED; the owner confirms them later.

### Journey decisions checked against the handlers
- Already right: double tap on Confirm (compare-and-swap, second tap silent); revoked token or disabled module fails the pending write; disabled connector keeps pending rows; self-approval refused before the claim, request stays pending; group chats get no reply; link code 10 minutes and replaced by a new one; 8 wrong tries per sender; unlink before relinking; disconnect erases the token and unlinks every chat.
- Changed: the "no project" reply is now "You do not have access to that project." (it no longer says the project may not exist); disconnect now revokes (with its audit row, one transaction) BEFORE it removes the webhook at Telegram, so a failed audit write leaves the connector untouched.
- Tests added: tap on a disabled connector keeps the row and writes nothing; linking pause and 10-minute copy; audit-failure atomicity on PATCH and DELETE; username kept as the display name.

### Settings UI
- Cards: `telegram-connector-card.tsx` (admin) and `telegram-account-card.tsx` (member), mounted under the Lark cards in `integrations-console.tsx`. Same Card, Button, Badge, Field, ConfirmDialog, CopyButton and InlineAlert primitives as the Lark cards; no new tokens, fonts, colours or dependencies. The cards hide with the page when the integrations module is off (the module registry owns the `/integrations` page and API prefix).
- Thin routes added because none existed: `POST /api/integrations/telegram/link-code`, `GET .../{id}/status` (getWebhookInfo), `POST .../{id}/test` (to the admin's own linked chat). OpenAPI, llms.txt and goldens updated.
- Fix found on the way: the identities list is shared by every chat platform, so the Lark card would have shown "linked" for a Telegram link. Each card now sees only its own platform's links (`identitiesFor`).
- The bot stores the member's @username (validated) as the link display name so the card can show it.

### Defaults chosen
- Admin "Disable" maps to connector status `paused`; "Reconnect" calls the setup route. A tap on a disabled connector gets a toast and the row is left open (it expires on its own TTL).
- Test message needs an active bot and the admin's own linked chat; otherwise 422.
- Webhook is "OK" only when Telegram holds this connector's URL and reports no delivery error.
- Link-code countdown is visible but not announced every second; a separate polite live region announces ready and expired.
- Screenshot: `settings-cards.png` from a throwaway page with static props (the settings page itself needs Supabase and a login, not available here). The throwaway page was deleted and the dev server stopped (port 3917 has no listener).
