/**
 * Lark / Feishu adapter for the Integration Hub.
 *
 * Pure translation + transport (see ConnectorAdapter in ../types.ts): render a
 * card, send / patch it through the official SDK, check credentials. The hub
 * core owns persistence, retries, identity and governance and imports only
 * `larkAdapter` from here.
 *
 * Deliberately does NOT import ./wiring (which imports the hub core): the hub
 * core imports this file, and a back-edge would make a cycle.
 */

import type { ConnectorAdapter } from "@/lib/integrations/types";
import {
  buildApprovalRequestCard,
  buildBacklogNoticeCard,
  buildChangedUpdateCard,
  buildDecisionUpdateCard,
  buildDigestCard,
} from "./cards";
import { patchCard, sendCard, testBot } from "./client";

export const larkAdapter: ConnectorAdapter = {
  kind: "lark",
  renderApprovalCard: (ev, ctx) => buildApprovalRequestCard(ev, ctx),
  // The decision time is "when we render the update": the hub patches cards the moment a decision lands.
  renderDecisionUpdate: (ev, ctx) => buildDecisionUpdateCard(ev, { appUrl: ctx.appUrl, decidedAt: new Date() }),
  renderDigest: (data) => buildDigestCard(data),
  renderChangedUpdate: (ev, ctx) => buildChangedUpdateCard(ev, ctx),
  renderBacklogNotice: (ctx) => buildBacklogNoticeCard(ctx),
  send: (connector, secrets, msg) => sendCard(connector, secrets, msg),
  update: (connector, secrets, externalMessageId, body) => patchCard(connector, secrets, externalMessageId, body),
  testConnection: (connector, secrets) => testBot(connector, secrets),
};

export { resolveAppUrl } from "./cards";
export { handleLarkPayload, type LarkHandlerContext, type LarkHandlerDeps, type LarkHttpResult } from "./handlers";
export type { LarkEnvelope } from "./verify";
