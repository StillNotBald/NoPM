/**
 * The seam between chat free text and the BYOK assistant (ADR 0004, ADR 0020).
 *
 * NoPM bundles no model. A linked user's non-command text is handed to
 * `askAssistant(actor, text)`. `defaultAskAssistant` is the "not wired" answer
 * (a fixed pointer to Settings) used by tests and by any host that passes no
 * implementation; production binds ./free-text.ts (`makeAskAssistant`) in
 * ./wiring.ts, which runs the shared engine read-only with the person's own key.
 *
 * Contract for any implementation: act as the linked human (an ephemeral
 * token created_by = actor.profileId), carry no approve or admin scope, never
 * write without the bot's Confirm card, and keep tool results as untrusted data.
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
