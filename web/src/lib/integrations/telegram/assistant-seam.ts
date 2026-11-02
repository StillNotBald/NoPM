/**
 * The seam between chat free text and the BYOK assistant (ADR 0004, ADR 0020).
 *
 * NoPM bundles no model. A linked user's non-command text is handed to
 * `askAssistant(actor, text)`. Until the shared assistant engine is wired in,
 * the default implementation answers with a fixed pointer to Settings. The lead
 * replaces `defaultAskAssistant` by passing `askAssistant` in `TelegramDeps`
 * (see ./wiring.ts); nothing in the handlers changes.
 *
 * Contract for the real implementation: act as the linked human (an ephemeral
 * token created_by = actor.profileId), carry the assistant's own scope list for
 * that role (never an approve or admin scope), and let deletes stay
 * maker-checker requests.
 */

import { COPY } from "./render";

export type AssistantActor = {
  workspaceId: string;
  profileId: string;
  role: string;
  label: string;
  connectorId: string;
};

export type AssistantReply = { text: string };

export type AskAssistant = (actor: AssistantActor, text: string) => Promise<AssistantReply>;

export const FREE_TEXT_STUB_REPLY = COPY.freeText;

export const defaultAskAssistant: AskAssistant = async () => ({ text: FREE_TEXT_STUB_REPLY });
