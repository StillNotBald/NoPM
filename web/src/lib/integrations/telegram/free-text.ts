/**
 * Free text in Telegram, wired to the shared assistant engine (ADR 0020, "Free-text mode"; R-200 to R-203).
 *
 * MODE BUILT: READ-ONLY. The engine (`runToolRounds`) cannot pause in the middle of a turn to show a
 * Confirm card, so a free-text turn is given read tools only and a token that carries read scopes only. When
 * the person wants to change something, the model says which numbered command does it (/2 add, /3 update or
 * request a deletion); that command shows the existing preview and Confirm card. No write ever runs from free
 * text, so no write can run without a confirm.
 *
 *   - Credential: the linked person's OWN saved key (the same `assistant_credentials` row the web assistant
 *     reads). No key means a fixed pointer to Settings. The shared demo key is never used from chat.
 *   - Token: one server-minted per-turn token (kind `telegram`, created_by = the linked human, channel
 *     `telegram` derived by the server), scopes = the assistant's own READ scopes. Never a write, delete-request,
 *     approve or admin scope; revoked in `finally`.
 *   - Tools: only tools whose route is a GET are offered. Tool results are wrapped as untrusted data by the
 *     engine (`wrapUntrustedToolResult`).
 *   - Provider failures become one short sentence from the typed errors (R-184); no upstream text is shown.
 *
 * Everything outside the engine arrives through `FreeTextDeps`, so the file is unit-tested with no database,
 * no network and no model.
 */

import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { chat, type Provider } from "@/lib/assistant/providers/index";
import { ProviderError, providerErrorMessage } from "@/lib/assistant/providers/errors";
import { TOOLS } from "@/lib/assistant/tools";
import { runToolRounds, TOOL_CAP_NOTE } from "@/lib/agent-core/tool-engine";
import { buildSystemPrompt } from "@/lib/agent-core/system-prompt";
import { disabledModuleIds } from "@/lib/modules";
import type { ConnectorRow } from "@/lib/integrations/types";
import type { AskAssistant, AssistantActor } from "./assistant-seam";
import { FREE_TEXT_READ_SCOPES, mintActionToken, revokeActionToken, type ActionToken } from "./token";
import { COPY } from "./render";
import type { LinkedProfile } from "@/lib/integrations/identity";

/** A turn can take several provider round trips; the revoke in `finally` is the real control. */
export const FREE_TEXT_TOKEN_TTL_MS = 5 * 60 * 1000;
/** Characters of the person's message forwarded to the model. */
export const MAX_QUESTION_CHARS = 2000;

export const NO_KEY_REPLY = COPY.freeText;

export type OwnCredential = { provider: Provider; apiKey: string; model: string };

export type FreeTextDeps = {
  /** The configured app URL (`trustedApiBase`); null = nothing is sent and the person is asked to try later. */
  origin: string | null;
  /** The person's own saved key, or null. Never the shared demo key. */
  loadCredential?(profileId: string): Promise<OwnCredential | null>;
  mint?(connector: ConnectorRow, profile: LinkedProfile, scopes: string[], opts: { ttlMs: number }): Promise<ActionToken>;
  revoke?(connector: ConnectorRow, profile: LinkedProfile, id: string, opts: { audit: boolean }): Promise<void>;
  run?: typeof runToolRounds;
  chatOnce?: typeof chat;
  log?(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void;
};

/** The person's own saved key (same table and decryption as the web assistant). Workspace of the actor is not needed: keys are per user. */
export async function loadOwnCredential(profileId: string): Promise<OwnCredential | null> {
  const { data, error } = await createAdminClient()
    .from("assistant_credentials")
    .select("provider, api_key_enc, model")
    .eq("user_id", profileId)
    .maybeSingle();
  if (error || !data) return null;
  return { provider: data.provider as Provider, apiKey: decrypt(data.api_key_enc as string), model: data.model as string };
}

/** Tools whose own route is a GET: the only ones a free-text turn is offered. */
export function readOnlyToolDefinitions() {
  return TOOLS.filter((t) => String(t.toRequest({}).method).toUpperCase() === "GET").map((t) => t.definition);
}

const CHAT_RULES = `You are answering in a Telegram chat. This chat is READ-ONLY: you have only tools that read, and you cannot create, change, approve or delete anything from here.
If the person asks for a change, do not claim to have made it. Tell them the command that does it: /2 to add a task, issue or risk, /3 to update a task or request its deletion, /4 to decide approvals. Those commands show a preview and a Confirm button.
Answer in plain text, no markdown, at most about 1200 characters. Name things by their names, never by raw ids.`;

function systemFor(actor: AssistantActor): string {
  return `${buildSystemPrompt({ who: { label: actor.label, role: actor.role }, disabledModules: disabledModuleIds() })}\n\n${CHAT_RULES}`;
}

/** One short sentence for a failed turn. Typed provider errors (R-184) keep their kind; anything else is a generic retry. */
export function freeTextErrorMessage(err: unknown): string {
  return err instanceof ProviderError ? providerErrorMessage(err.kind, err.provider) : COPY.tryAgain;
}

export function makeAskAssistant(connector: ConnectorRow, d: FreeTextDeps): AskAssistant {
  const loadCredential = d.loadCredential ?? loadOwnCredential;
  const mint = d.mint ?? mintActionToken;
  const revoke = d.revoke ?? revokeActionToken;
  const run = d.run ?? runToolRounds;
  const chatOnce = d.chatOnce ?? chat;
  const log = d.log ?? (() => undefined);

  return async (actor, rawText) => {
    const question = rawText.trim().slice(0, MAX_QUESTION_CHARS);
    if (!question) return { text: COPY.freeText };

    let cred: OwnCredential | null;
    try {
      cred = await loadCredential(actor.profileId);
    } catch {
      return { text: COPY.tryAgain };
    }
    if (!cred) return { text: NO_KEY_REPLY };
    if (!d.origin) return { text: COPY.tryAgain };

    const profile: LinkedProfile = { profileId: actor.profileId, role: actor.role as LinkedProfile["role"], label: actor.label };
    let token: ActionToken;
    try {
      token = await mint(connector, profile, [...FREE_TEXT_READ_SCOPES], { ttlMs: FREE_TEXT_TOKEN_TTL_MS });
    } catch {
      // A token that cannot be minted (or audited) means the turn does not run.
      return { text: COPY.tryAgain };
    }

    try {
      const system = systemFor(actor);
      const tools = readOnlyToolDefinitions();
      const messages = [{ role: "user" as const, content: question }];
      const outcome = await run({
        provider: cred.provider,
        apiKey: cred.apiKey,
        model: cred.model,
        system,
        messages,
        tools,
        ctx: { origin: d.origin, token: token.raw, channel: "telegram" },
        actions: [],
      });
      if (outcome.kind === "text") return { text: outcome.text?.trim() || "Done." };
      if (outcome.kind === "cap") return { text: TOOL_CAP_NOTE };
      const last = await chatOnce({
        provider: cred.provider,
        apiKey: cred.apiKey,
        model: cred.model,
        system,
        messages: [...messages, { role: "user", content: "Please answer with what you have found so far." }],
        tools: [],
      });
      return { text: last.text?.trim() || "Done." };
    } catch (err) {
      const kind = err instanceof ProviderError ? err.kind : "other";
      log("warn", "telegram free-text turn failed", { connectorId: connector.id, kind });
      return { text: freeTextErrorMessage(err) };
    } finally {
      // Read scopes only: the mint row is the turn's one audit row (see revokeActionToken).
      await revoke(connector, profile, token.id, { audit: false });
    }
  };
}
