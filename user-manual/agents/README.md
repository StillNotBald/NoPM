# Agent surfaces — pointer

**Status: ACTIVE (pointer only)** · This file is intentionally thin — orientation + links, not a copy of any surface's real docs. If a surface's own README changes, this file does not need to be edited; it never restates content.

NoPM bundles no LLM. Every one of the surfaces below drives the same governed REST API (`/api/**`, documented in [OpenAPI](../../web/src/app/api/openapi.json) and [`/llms.txt`](../../web/src/app/llms.txt)) through a scoped Bearer PAT — audit trail, scopes, and maker-checker are enforced server-side regardless of which surface an agent uses.

## `nopm` CLI

Zero-dependency terminal client — every command is a thin call to the public REST API (no direct DB access, so it can't bypass governance). Supports `--json` for machine-readable output and `--curl` to preview a request without sending it. Point it at a scoped PAT with `nopm auth set-token` and it's ready for a human or an agent to drive from a shell.

→ Full command reference: [`cli/README.md`](../../cli/README.md)

## MCP server

A native stdio Model Context Protocol server (`web/mcp/`) that lets any MCP client — Claude Desktop, Claude Code, Cursor, or a custom agent — call NoPM as a set of governed tools. It's the same thin bridge as the CLI (maps tool calls to REST API calls with a scoped PAT); no bundled model, no direct DB access.

→ Setup + tool catalogue: [`web/mcp/README.md`](../../web/mcp/README.md) · root [`.mcp.json`](../../.mcp.json)

## `/llms.txt`

A machine-readable, plain-text orientation document served live at `/llms.txt` — base URL, auth scheme, the `{ data }` / `{ error }` response contract, HTTP status codes (including `429` rate-limit semantics), and pagination rules. It's the fastest way for an agent (or a person skimming) to learn the API's shape without parsing the full OpenAPI spec.

→ Live: `https://stillnotbald.com/llms.txt` · source: `web/src/app/llms.txt/route.ts`

## BYOK assistant

An in-app AI panel (opened from the top bar in the console shell — see [`operator/01-getting-started.md`](../operator/01-getting-started.md)) where you paste your **own** OpenAI/Anthropic/Google API key (AES-256-GCM encrypted at rest). The assistant then drives NoPM through an ephemeral, narrowly-scoped token minted fresh per turn — audited as a token actor in the Trust Center, and structurally unable to hold an approve/admin scope. NoPM still ships no model and no key of its own; an owner-funded demo key may be configured server-side to let the public demo try it without a visitor's own key.

→ Setup UI: `web/src/components/assistant/setup.tsx` · scope/tool registry: `web/src/lib/assistant/`

## Update 2026-10-18 - common-pattern answers

- New API surface: `POST /change-requests/{id}/review`, `POST /change-requests/{id}/reopen`, `POST /rebaselines/{id}/withdraw`, `POST /invites/{id}/renew`, `/members*` (session only), `GET/PATCH /workspace-settings`, connector `deliveries` list and retry. New MCP/assistant tool `withdraw_deletion_request`; new CLI command `nopm approve withdraw <id>`.
- Tokens default to a 90-day life; read `days_left` from `GET /tokens`. Unknown body fields are refused 422. Branch on `code`, not on the message.

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).
