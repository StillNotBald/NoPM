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
