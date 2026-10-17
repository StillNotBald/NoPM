/**
 * Lark / Feishu inbound event handling — transport-agnostic.
 *
 * Everything here takes an ALREADY-VERIFIED event envelope (see ./verify.ts or
 * the relay's HMAC check) plus the connector it belongs to, and returns what
 * the platform should be told. The hosted webhook routes and the self-host
 * relay route both end up in `handleCardAction` / `handleLarkPayload`, so there
 * is exactly one code path from "a person tapped a button in Lark" to a
 * governed decision.
 *
 * What this module does NOT do (hub core): look the connector up, decrypt
 * secrets, resolve identities, consume action tokens, make the decision. Those
 * arrive as `LarkHandlerDeps`; the single place that binds them to the real
 * implementations is ./wiring.ts. Tests inject fakes.
 *
 * Governance contract (PLAN D3/D7/D8):
 *   • The ONLY mutations an inbound event can cause are `handleApprovalAction`
 *     — a human, identity-verified, single-use approve/reject — and the
 *     one-time-code identity link. No other command writes anything.
 *   • The decision is made by NoPM, never by this module: a button only carries
 *     `{ t, a }`; who clicked comes from the platform-signed `operator.open_id`
 *     + `tenant_key`, mapped to a pre-linked NoPM user by the hub.
 *   • Never throws to the platform: every failure becomes a toast or a
 *     swallowed-and-logged error. Logs carry ids and reasons, never tokens,
 *     codes, free text, or secrets.
 *
 * Response deadlines (docs): a card callback must be answered with HTTP 200
 * within 3 s, so the decision call is raced against a 2.5 s timer — on a slow
 * path the user gets an "in progress" toast and the work continues in the
 * background; the hub's decision-update patch then refreshes the card.
 */

import type { ConnectorRow, DeliverResult, InboundOutcome, LarkSecrets, OutboundMessage } from "@/lib/integrations/types";
import type { ApprovalActionInput } from "@/lib/integrations/inbound";
import type { ConsumeLinkInput, LinkOutcome } from "@/lib/integrations/identity";
import {
  MAX_REJECT_REASON,
  buildDecidedCard,
  buildHelpCard,
  buildLinkReplacedCard,
  buildLinkConfirmationCard,
  buildNoticeCard,
  buildPendingApprovalsCard,
  buildUnlinkedCard,
  cardCallbackResponse,
  escapeLarkMd,
  type CardCallbackResponse,
  type LarkCard,
} from "./cards";
import { extractMessageText, parseCommand } from "./commands";
import type { LarkEnvelope } from "./verify";

// ---------------------------------------------------------------------------
// Contracts with the hub core
//
// `ApprovalActionInput`, `ConsumeLinkInput` and `LinkOutcome` are the hub
// core's own types (type-only imports: no runtime coupling), so a change there
// is a compile error here rather than a silent drift.
// ---------------------------------------------------------------------------

export type { ApprovalActionInput, ConsumeLinkInput, LinkOutcome };

export type PendingApprovalsInput = {
  connector: ConnectorRow;
  externalTenant: string;
  externalUserId: string;
};

/** How many requests wait on this person (console-badge semantics, four-eyes excluded). */
export type PendingApprovalsResult =
  | { status: "unlinked" }
  | { status: "not_approver" }
  | { status: "ok"; deletions: number; changeRequests: number }
  | { status: "error" };

export type LogLevel = "info" | "warn" | "error";

export type LarkHandlerDeps = {
  handleApprovalAction(input: ApprovalActionInput): Promise<InboundOutcome>;
  consumeLinkCode(input: ConsumeLinkInput): Promise<LinkOutcome>;
  countPending(input: PendingApprovalsInput): Promise<PendingApprovalsResult>;
  /** True the first time an event id is seen for this connector, false for a redelivery. */
  claimEvent(connectorId: string, eventId: string): Promise<boolean>;
  /** Send a DM / message through the connector's bot. */
  send(connector: ConnectorRow, secrets: LarkSecrets, msg: OutboundMessage): Promise<DeliverResult>;
  now(): Date;
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
};

export type LarkHandlerContext = {
  connector: ConnectorRow;
  secrets: LarkSecrets;
  /** Public NoPM base URL for deep links ("" when unknown: cards then omit links). */
  appUrl: string;
  /**
   * Keep work running after the HTTP response has gone out (Next's `after`).
   * Absent → the work is awaited inline (tests).
   */
  background?: (work: Promise<unknown>) => void;
};

export type LarkHttpResult = { status: number; body: unknown };

/** Slightly under the platform's 3 s card-callback deadline. */
export const CARD_DEADLINE_MS = 2500;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : "unknown error";
}

/**
 * Postgres text cannot hold NUL; control characters (other than tab / newline)
 * have no business in an audit note. Bidirectional controls go too: a reject
 * reason is stored verbatim in the audit trail and shown to other people, and
 * U+202E and friends can make one sentence read as another.
 */
function cleanNote(raw: string): string {
  return raw.replace(/[^\P{Cc}\t\n\r]/gu, "").replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "").trim();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Dispatch one verified envelope. `card.action.trigger` is answered inline
 * (toast + card); `im.message.receive_v1` is acknowledged immediately and its
 * reply is produced in the background; everything else is acknowledged and
 * ignored. A `url_verification` handshake is answered with its challenge.
 */
export async function handleLarkPayload(
  ctx: LarkHandlerContext,
  envelope: LarkEnvelope,
  deps: LarkHandlerDeps,
): Promise<LarkHttpResult> {
  if (envelope.type === "url_verification") {
    return { status: 200, body: { challenge: typeof envelope.challenge === "string" ? envelope.challenge : "" } };
  }

  const header = isRecord(envelope.header) ? envelope.header : {};
  if (str(header.app_id) && str(header.app_id) !== ctx.connector.config.appId) {
    deps.log("warn", "lark event for a different app ignored", { connectorId: ctx.connector.id });
    return { status: 200, body: {} };
  }
  if (!isRecord(envelope.header) && envelope.type === "event_callback") {
    // Legacy (1.0) event schema: the console's "Receive message" event must be the v2.0 one.
    deps.log("warn", "legacy v1 lark event ignored; subscribe to the v2.0 message event", { connectorId: ctx.connector.id });
    return { status: 200, body: {} };
  }

  switch (str(header.event_type)) {
    case "card.action.trigger":
      return { status: 200, body: await handleCardAction(ctx, envelope, deps) };

    case "im.message.receive_v1": {
      const work = processMessageEvent(ctx, envelope, deps).catch((err) => {
        deps.log("error", "lark message event failed", { connectorId: ctx.connector.id, error: errorMessage(err) });
      });
      if (ctx.background) ctx.background(work);
      else await work;
      return { status: 200, body: {} };
    }

    default:
      return { status: 200, body: {} };
  }
}

// ---------------------------------------------------------------------------
// card.action.trigger
// ---------------------------------------------------------------------------

export async function handleCardAction(
  ctx: LarkHandlerContext,
  envelope: LarkEnvelope,
  deps: LarkHandlerDeps,
): Promise<CardCallbackResponse> {
  const header = isRecord(envelope.header) ? envelope.header : {};
  const event = isRecord(envelope.event) ? envelope.event : {};
  const operator = isRecord(event.operator) ? event.operator : {};
  const action = isRecord(event.action) ? event.action : {};

  if (!ctx.connector.config.approvals.enabled) {
    return cardCallbackResponse("warning", "Approving from Lark is turned off for this workspace. Open NoPM to decide.");
  }

  const eventId = str(header.event_id);
  const openId = str(operator.open_id);
  const tenant = str(operator.tenant_key) || str(header.tenant_key);
  if (!eventId || !openId || !tenant) {
    return cardCallbackResponse("error", "I could not tell who pressed that. Open NoPM to decide.");
  }

  const value = isRecord(action.value) ? action.value : null;
  const token = value ? str(value.t) : "";
  const verb = value?.a;
  if (!token || token.length > 256 || (verb !== "approve" && verb !== "reject")) {
    return cardCallbackResponse("warning", "This card is out of date. Open NoPM to decide.");
  }

  let note: string | null = null;
  if (verb === "reject") {
    const form = isRecord(action.form_value) ? action.form_value : {};
    note = cleanNote(str(form.reason));
    // Checked BEFORE the hub is called, so a missing reason never burns the single-use token.
    if (!note) return cardCallbackResponse("warning", "Add a reason to reject this request.");
    if (note.length > MAX_REJECT_REASON) {
      return cardCallbackResponse("warning", `Keep the reason under ${MAX_REJECT_REASON} characters.`);
    }
  }

  const pending = deps
    .handleApprovalAction({
      connector: ctx.connector,
      externalEventId: eventId,
      externalTenant: tenant,
      externalUserId: openId,
      actionToken: token,
      action: verb,
      note,
    })
    .catch((err): InboundOutcome => {
      deps.log("error", "approval action threw", { connectorId: ctx.connector.id, error: errorMessage(err) });
      return { status: "error", message: "unexpected error" };
    });

  const TIMED_OUT = Symbol("timed-out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), CARD_DEADLINE_MS);
  });
  const outcome = await Promise.race([pending, deadline]).finally(() => clearTimeout(timer));

  if (outcome === TIMED_OUT) {
    // The decision is still being recorded; keep the instance alive for it.
    if (ctx.background) ctx.background(pending);
    return cardCallbackResponse("info", "Recording your decision. This card will update when it is done.");
  }
  return outcomeToResponse(ctx, deps, outcome);
}

function outcomeToResponse(ctx: LarkHandlerContext, deps: LarkHandlerDeps, outcome: InboundOutcome): CardCallbackResponse {
  switch (outcome.status) {
    case "decided": {
      const card = buildDecidedCard({
        ref: outcome.ref,
        title: outcome.title,
        status: outcome.newStatus,
        channel: "lark",
        decidedAt: deps.now(),
        appUrl: ctx.appUrl,
      });
      return cardCallbackResponse(
        "success",
        outcome.action === "approve" ? "Approved. Recorded in NoPM." : "Rejected. Recorded in NoPM.",
        card,
      );
    }
    case "unlinked":
      return cardCallbackResponse(
        "error",
        "Your Lark account is not linked to NoPM. Send me `link NPL-XXXX-XXXX` first (create the code in NoPM, under Integrations).",
      );
    case "expired":
      return cardCallbackResponse("warning", "This approval card has expired. Open NoPM to decide.");
    case "not_recipient":
      return cardCallbackResponse("error", "This request was not sent to you.");
    case "self_approval":
      return cardCallbackResponse("error", "You cannot decide a request you raised (four-eyes). Ask another approver.");
    case "already_decided":
      return cardCallbackResponse("info", "Already decided. This card will refresh shortly.");
    case "changed":
      return cardCallbackResponse(
        "warning",
        "This request changed after the card was sent, so nothing was decided. Open the new card, or open NoPM to review it.",
      );
    case "forbidden":
      return cardCallbackResponse("error", outcome.message || "You do not have permission to decide this request.");
    case "invalid":
      return cardCallbackResponse("warning", outcome.message || "That request is no longer valid. Open NoPM to check.");
    case "error":
      return cardCallbackResponse("error", "Could not record your decision. Try again, or decide in NoPM.");
  }
}

// ---------------------------------------------------------------------------
// im.message.receive_v1 (bot DMs)
// ---------------------------------------------------------------------------

async function processMessageEvent(ctx: LarkHandlerContext, envelope: LarkEnvelope, deps: LarkHandlerDeps): Promise<void> {
  const header = isRecord(envelope.header) ? envelope.header : {};
  const event = isRecord(envelope.event) ? envelope.event : {};
  const sender = isRecord(event.sender) ? event.sender : {};
  const senderId = isRecord(sender.sender_id) ? sender.sender_id : {};
  const message = isRecord(event.message) ? event.message : {};

  // Only people, only 1:1 chats: ignores group chatter and the bot's own messages (no loops).
  if (str(sender.sender_type) !== "user") return;
  if (str(message.chat_type) !== "p2p") return;

  const openId = str(senderId.open_id);
  const tenant = str(sender.tenant_key) || str(header.tenant_key);
  // The dedupe key is the MESSAGE id: when a push is not acknowledged in time Lark
  // sends the same message again under a NEW event id (the docs say to dedupe on
  // message_id). The event id is only the fallback for a message without one.
  const eventId = str(message.message_id) || str(header.event_id);
  if (!openId || !eventId) return;

  // Process each message once.
  if (!(await deps.claimEvent(ctx.connector.id, eventId))) return;

  const reply = async (card: LarkCard): Promise<void> => {
    const res = await deps.send(ctx.connector, ctx.secrets, { receiveIdType: "open_id", receiveId: openId, body: card });
    if (!res.ok) deps.log("warn", "lark bot reply failed", { connectorId: ctx.connector.id, retryable: res.retryable, error: res.error });
  };

  const command = parseCommand(extractMessageText(str(message.message_type), message.content));

  switch (command.kind) {
    case "help":
    case "unknown":
      return reply(buildHelpCard(ctx.appUrl));

    case "approvals": {
      if (!tenant) return reply(buildHelpCard(ctx.appUrl));
      const res = await deps.countPending({ connector: ctx.connector, externalTenant: tenant, externalUserId: openId });
      switch (res.status) {
        case "unlinked":
          return reply(buildUnlinkedCard(ctx.appUrl));
        case "not_approver":
          return reply(
            buildNoticeCard({
              tone: "info",
              title: "Nothing to decide",
              lines: ["Approval requests go to workspace admins and managers, and your role is not one of those."],
              appUrl: ctx.appUrl,
            }),
          );
        case "error":
          return reply(
            buildNoticeCard({
              tone: "error",
              title: "Could not load approvals",
              lines: ["Something went wrong. Try again in a minute, or open NoPM."],
              appUrl: ctx.appUrl,
            }),
          );
        case "ok":
          return reply(buildPendingApprovalsCard({ deletions: res.deletions, changeRequests: res.changeRequests, appUrl: ctx.appUrl }));
      }
      return;
    }

    case "link": {
      if (!command.code) {
        return reply(
          buildNoticeCard({
            tone: "warning",
            title: "Link code needed",
            lines: ["Send `link NPL-XXXX-XXXX` with the code from NoPM (Integrations, then Link my account). Codes last 10 minutes."],
            appUrl: ctx.appUrl,
          }),
        );
      }
      if (!tenant) {
        return reply(buildNoticeCard({ tone: "error", title: "Could not link", lines: ["I could not read your workspace from that message. Try again."] }));
      }
      const res = await deps.consumeLinkCode({
        connector: ctx.connector,
        rawCode: command.code,
        externalTenant: tenant,
        externalUserId: openId,
        externalUnionId: str(senderId.union_id) || null,
        externalEventId: eventId,
      });
      await reply(linkOutcomeCard(ctx, deps, res));
      // The link replaced an earlier one: tell the account that just lost it.
      // Best-effort, and only after the new account has its confirmation.
      if (res.status === "linked" && res.displaced) {
        for (const old of res.displaced) {
          const sent = await deps
            .send(ctx.connector, ctx.secrets, {
              receiveIdType: "open_id",
              receiveId: old.externalUserId,
              body: buildLinkReplacedCard({ appUrl: ctx.appUrl }),
            })
            .catch((err): DeliverResult => ({ ok: false, retryable: true, error: errorMessage(err) }));
          if (!sent.ok) deps.log("warn", "could not tell the displaced account", { connectorId: ctx.connector.id, retryable: sent.retryable });
        }
      }
      return;
    }
  }
}

function linkOutcomeCard(ctx: LarkHandlerContext, deps: LarkHandlerDeps, res: LinkOutcome): LarkCard {
  switch (res.status) {
    case "linked":
      return res.alreadyLinked
        ? buildNoticeCard({
            tone: "info",
            title: "Already linked",
            lines: ["This Lark account is already linked to your NoPM user. Nothing changed."],
            appUrl: ctx.appUrl,
          })
        : buildLinkConfirmationCard({ displayName: res.profileLabel, appUrl: ctx.appUrl });
    case "invalid_code":
      return buildNoticeCard({
        tone: "error",
        title: "Code not recognised",
        lines: ["That code is not valid. Create a new one in NoPM (Integrations, then Link my account)."],
        appUrl: ctx.appUrl,
      });
    case "already_used":
      return buildNoticeCard({ tone: "warning", title: "Code already used", lines: ["That code was already used. Create a new one in NoPM."], appUrl: ctx.appUrl });
    case "expired":
      return buildNoticeCard({
        tone: "warning",
        title: "Code expired",
        lines: ["That code has expired (codes last 10 minutes). Create a new one in NoPM."],
        appUrl: ctx.appUrl,
      });
    case "conflict":
      return buildNoticeCard({ tone: "warning", title: "Could not link", lines: [escapeLarkMd(res.message, 300)], appUrl: ctx.appUrl });
    case "forbidden":
      // e.g. the account belongs to a different Lark tenant than the one this connector is pinned to.
      return buildNoticeCard({ tone: "error", title: "Wrong Lark workspace", lines: [escapeLarkMd(res.message, 300)], appUrl: ctx.appUrl });
    case "rate_limited":
      return buildNoticeCard({
        tone: "warning",
        title: "Too many attempts",
        lines: ["Too many link attempts from this account. Wait a few minutes, then send the newest code from NoPM."],
        appUrl: ctx.appUrl,
      });
    case "paused":
      return buildNoticeCard({ tone: "warning", title: "Integration paused", lines: ["Your workspace admin has paused this integration."], appUrl: ctx.appUrl });
    case "error":
      deps.log("warn", "identity link failed", { connectorId: ctx.connector.id });
      return buildNoticeCard({ tone: "error", title: "Could not link", lines: ["Something went wrong. Try again in a minute."], appUrl: ctx.appUrl });
  }
}

// ---------------------------------------------------------------------------
// Entry points for transports that hold a ConnectorRow but no request context
// (the self-host relay route). They bind the production dependencies lazily, so
// this module stays free of hub-core runtime imports for tests and tooling.
// ---------------------------------------------------------------------------

/** A `card.action.trigger` payload → the JSON the platform expects back (`{ toast, card? }`). */
export async function handleLarkCardAction(connector: ConnectorRow, payload: Record<string, unknown>): Promise<unknown> {
  const { productionContext } = await import("./wiring");
  const { ctx, deps } = productionContext(connector);
  return handleCardAction(ctx, payload as LarkEnvelope, deps);
}

/** Any other verified event payload (bot DMs) → the JSON the platform expects back (`{}`). */
export async function handleLarkEvent(connector: ConnectorRow, payload: Record<string, unknown>): Promise<unknown> {
  const { productionContext } = await import("./wiring");
  const { ctx, deps } = productionContext(connector);
  return (await handleLarkPayload(ctx, payload as LarkEnvelope, deps)).body;
}
