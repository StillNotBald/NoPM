# UC-18 · BYOK governed assistant session

**Goal:** Let a user's own LLM (their own OpenAI/Anthropic/Google/OpenRouter API key) operate NoPM conversationally, without NoPM ever holding a standing credential broader than what one conversation turn needs.

**Actors:** Team member / Project Manager (owns the session, pastes their own key). The assistant itself acts as a token actor in the audit trail, never as the human directly.

**Preconditions:** The user has a session; either they have stored their own provider API key, or an owner-funded demo key is configured server-side for public-demo use.

**Trigger:** A user wants to ask NoPM's assistant to do something ("create a task for the cutover dry-run", "what's over budget right now") instead of clicking through the UI or writing API calls by hand.

## Main flow

1. Store a provider key: `PUT /api/assistant/credentials` (user session only) — AES-256-GCM encrypted at rest, never returned or logged. `GET /api/assistant/credentials` checks status without ever returning the key. `DELETE /api/assistant/credentials` removes it.
2. Open the assistant panel from the top bar (a slide-over panel, not a separate route) and send a message: `POST /api/assistant/chat` (user session only, SSE or JSON response).
3. At the start of the turn, NoPM mints a fresh **ephemeral** `api_tokens` row scoped to the assistant's tool set (`mintEphemeralToken`, 1-hour TTL, labelled `"AI Assistant · <actor label>"` and marked `kind = 'assistant'` — the column, never the name, is what filters it out of the human Tokens list). Scopes are derived from the signed-in user's own role: a **viewer** gets read-only tool scopes only (`TOOL_SCOPES.filter(read)`); anyone else gets the full assistant tool-scope set — the assistant can never grant a viewer session write access it wouldn't otherwise have.
4. The assistant drives NoPM through this ephemeral token, calling the **same governed REST API** every other surface uses — same scopes, same audit, same maker-checker. The token is revoked at the end of the turn (caller must call `revokeEphemeralToken` in a `finally` block).
5. Streaming: SSE streams the final reply; the underlying JSON response path is byte-for-byte preserved for non-streaming callers (R-26).
6. Saved conversations: `GET /api/assistant/conversations`, `GET /api/assistant/conversations/{id}` (user session only, deny-all RLS, API-owned). The shared demo login gets a fresh chat every visit — no conversation is ever created, loaded, or persisted for that identity, so no visitor's chat is reachable by the next.

## Alternate and exception flows

- **No provider call succeeds** (no stored credentials, demo key exhausted, upstream network/capacity error) → a deterministic grounded fallback answers from the same read-only tools over the same ephemeral-token lifecycle, itself rate-limited, never a write, never a raw upstream error surfaced to the user.
- **The assistant is prompt-injected** (e.g. tricked by hostile text inside a task description it read) into attempting something destructive → it is structurally bounded: the assistant's scope ceiling never includes an approve/admin/token-management scope, so even a successfully "tricked" tool call would `403` at the API layer. This ceiling is machine-checked by the test suite, not just documented.
- **Viewer session** → assistant tool calls are limited to read-only scopes regardless of what the user asks it to do.
- **Assistant credential set/revoke** → audited as `assistant.credential.set`/`assistant.credential.revoke`, carrying only `{provider, model}` before/after — **never** the API key itself, proven by a source-scan unit test inspecting the literal `writeAudit(...)` call bodies (R-83).

## Postconditions

- Every write the assistant makes is audited as a `token` actor (the ephemeral token), `channel: assistant`, with its own `request_id` so a whole turn's tool calls correlate under one id.
- The ephemeral token no longer exists (or is expired) after the turn ends.

## Reporting and evidence

- Trust Center rows from an assistant turn are visible exactly like any human or CLI write, distinguished by `channel: assistant` and the `"AI Assistant · …"` token label. (The label is cosmetic: whether a token is the assistant's is recorded in `api_tokens.kind`, which is what hides it from the Tokens list.)
- `web/src/lib/assistant/scopes.test.ts` and the shared MCP/assistant tool registry (R-64) are the direct evidence that the assistant's ceiling matches the CLI/MCP surfaces' least-privilege posture.

## Traceability

- R-IDs: R-24 (BYOK governed AI assistant), R-26 (assistant streaming + conversation persistence).
- Key files: `web/src/lib/assistant/token.ts`, `web/src/lib/assistant/tools.ts`, `web/src/lib/assistant/fallback.ts`, `web/src/app/api/assistant/chat/route.ts`, `web/src/app/api/assistant/credentials/route.ts`, `web/src/components/assistant/setup.tsx`.
- Tests: `web/src/lib/assistant/scopes.test.ts` (never holds an approve/admin/token scope), `web/src/lib/assistant/tools-zod.test.ts` (field-level drift lock).

## Open questions

None outstanding; this flow was verified directly against `docs/guide/03-how-governance-works.md`'s "Scoped credentials for AI specifically" section and `web/src/lib/assistant/token.ts` read verbatim.
