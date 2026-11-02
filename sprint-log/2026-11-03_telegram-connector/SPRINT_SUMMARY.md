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
- Free-text wiring to the shared assistant engine (done in the Free text section below).
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

## Review round 1 (2026-11-03)
Fixes for the review in `_docs/nopm-telegram-2026-11-03/08-review-telegram-branch.md`. Each has a regression test.

### Important
- **I-1 migration.** The rewrite now matches every `channel not in (...)` list that names `'lark'` (both list forms, in `nopm_commit_*_deletion`, `nopm_decide_change_request`, `nopm_audit_insert`, `nopm_mutate_audited` and the rest) and adds `'telegram'`; it skips lists that already have it, so it can run twice. A second `DO` block ends the migration and raises if any function still lists `'lark'` without `'telegram'`. New test `telegram/migration-channels.test.ts` reads all migrations, takes the latest definition of every function, and fails if a function created after 0120 forgets `'telegram'`, or if any older one would not be fixed by the rewrite. Not run against a database. A local rehearsal with a plain `postgres` container was skipped: the functions use Supabase roles and tables, so a bare container would not load them.
- **I-2 coverage test.** `api/integrations/telegram/[connectorId]/test` sends a message and writes nothing in NoPM; added to the audit-coverage ALLOWLIST with that reason.
- **I-3 / SEC-1 approval card.** `/4` now shows `Delete <type> "<name>"` from the `deletion_requests.before` snapshot, key fields (project, due date, amount when present), the requester, and the reason labelled "Requester's reason (their words, not NoPM's)". Same facts as the Lark card (title, details, quoted reason). No snapshot: "Target details unavailable - approve in the web app." and no buttons. The tap handler repeats the check, so a forged `ap:` tap on such a card does nothing.

### Nits fixed
- /4 offers Approve only for the seven decidable types (`APPROVABLE_DELETION_TYPES`, pinned to the token allow-list by a test); other types say "Approve in the web app."
- Unlink (Telegram links only) clears the chat's command menu and the person's pending rows, best effort after the audited unlink.
- Dedupe: the `seen` row is `claimed` while processing, then `done` or `failed`; a `failed` key is reclaimed by compare-and-swap so a redelivery is processed again, and the person gets "Something went wrong" instead of silence.
- Per-sender rate limit (60/min) inside the webhook, before the connector budget, so one flooding sender is dropped and cannot spend the shared 300/min. Taps now also count against the per-person 30/min handler budget.
- The action bearer goes only to `trustedApiBase()`: `NEXT_PUBLIC_APP_URL` or the platform production host; a request-derived origin is accepted only if it is loopback. Nothing configured: no token is minted and nothing is sent (503). Redirects are not followed.
- Audit volume: a read-only chat token is audited once (the mint). A write token keeps mint plus revoke, like the web assistant.
- Revoke fallback: when the audited revoke fails the token is still killed and a fallback `telegram.token.revoke` row (`after.fallback = true`) is written. Added to the atomicity exceptions list with that reason.
- `chat_pending` rows older than 7 days are deleted lazily on each new dedupe insert.

### Lows left as one line
N-3 disconnect token erase has no retry sweep; N-7 weak 429-vs-401 existence oracle on unknown connector ids; N-10 link flow reuses the Lark rate-limit keys and fails open; N-12 (a) role demotion keeps the chat menu until relink, (b) one bot token can be connected in two workspaces, (c) disconnect does not clear per-chat menus, (d) empty index reads as 0, (e) no-op second replace in `redact`; N-4 index on `(connector_id, kind, created_at)` not added.

## Free text (2026-11-03, Part 2)
Requirements R-200 to R-203. Stacked on `feat/assistant-connector-polish` (PR #27), merged into this branch with `--no-ff`; the only conflict was the REQUIREMENTS rows (R-186 to R-189 from that branch kept, then R-190 onward).

### Mode built: READ-ONLY
The shared engine (`runToolRounds`) cannot pause mid-turn for a Confirm card, so free text is read-only and writes are suggested as the matching numbered command (/2, /3, /4), which already shows the preview and Confirm button. No write runs from free text.

### What it does
- `telegram/free-text.ts` (`makeAskAssistant`, bound in `wiring.ts`): loads the linked person's OWN saved key (never the demo key), mints one per-turn token with the assistant's `:read` scopes only (`FREE_TEXT_READ_SCOPES`, 5-minute TTL, mint audited, revoke without a second audit row), runs the shared engine with only the GET tools and a Telegram-specific rules block on top of the shared system prompt, and revokes in `finally`.
- No key: "Add your own model key in Settings → Assistant to ask questions in chat." Provider errors use the typed messages (R-184); anything else is the generic try-again line. No configured app URL: nothing is minted or sent.
- Replies: escaped, split under 4096 characters, at most three messages, with a "(Shortened...)" note.
- Tool results stay wrapped as untrusted data (engine unchanged).

### Tests
No key; key present (mocked provider, real engine in two tests); every provider error kind; the minted scopes contain no write, approve, admin or wildcard scope and the token allow-list still refuses them; a model that asks for a write tool gets none (not offered, token cannot write); group chats ignored; long answers split and capped; tool result wrapped and the bearer is the per-turn token.

### Not done
- Write-with-confirm from free text (needs an engine stop before a write tool call).
- No conversation history across messages: each free-text message is its own turn.
- Live check with a real key and a real bot.
