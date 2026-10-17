/**
 * Lark / Feishu card JSON 2.0 builders — pure functions, no I/O, deterministic
 * (snapshot-tested). The hub core persists the returned object as the delivery
 * payload; the client serialises it into `content` of an interactive message.
 *
 * Verified against the official card docs (open.feishu.cn, 2026-10-16):
 *   • Top level is `schema:"2.0"`, `config`, `header`, `body.elements[]`; JSON
 *     2.0 supports only shared cards, so `config.update_multi` is `true`
 *     (which is also what the message-patch API requires to edit a card in
 *     place). `header.template` takes blue|wathet|turquoise|green|yellow|
 *     orange|red|carmine|violet|purple|indigo|grey|default.
 *   • A button's callback payload is `behaviors:[{type:"callback", value}]`
 *     and arrives verbatim at `event.action.value` of `card.action.trigger`.
 *   • A form container holds `input` components and a button with
 *     `form_action_type:"submit"` + a unique `name`; submitted fields arrive
 *     at `event.action.form_value` keyed by input `name`; an input with
 *     `required:true` blocks submit client-side (no callback is sent).
 *   • Special characters in markdown are escaped as HTML numeric entities
 *     (`&#60;` for `<` …). User-supplied text (titles, names) is escaped here
 *     so it can never become a link, an @-mention (`<at id=all>`) or markup.
 *
 * Action buttons carry ONLY `{ t, a }`: `t` is the raw single-use action token
 * minted for that exact recipient + approval, `a` the action. Nothing else
 * (no ids, no workspace, no scopes) rides on the button — the hub resolves
 * everything from the token server-side.
 */

import type {
  ApprovalDecidedEvent,
  ApprovalEvent,
  ApprovalKind,
  ApprovalRef,
  DigestData,
} from "@/lib/integrations/types";

export type LarkCard = Record<string, unknown>;

export type HeaderTemplate = "blue" | "wathet" | "green" | "orange" | "red" | "grey" | "turquoise" | "default";
export type ToastType = "info" | "success" | "warning" | "error";

/** Body of the HTTP 200 reply to a `card.action.trigger` callback (docs: toast + optional card). */
export type CardCallbackResponse = {
  toast: { type: ToastType; content: string };
  card?: { type: "raw"; data: LarkCard };
};

export const KIND_LABEL: Record<ApprovalKind, string> = {
  task_deletion: "Task deletion",
  project_deletion: "Project deletion",
  change_request: "Change request",
  timesheet: "Timesheet",
};

const CHANNEL_LABEL: Record<string, string> = {
  lark: "Lark",
  ui: "the NoPM web app",
  cli: "the CLI",
  mcp: "an agent (MCP)",
  api: "the API",
  assistant: "the in-app assistant",
};

/** The reject reason is stored in the audit trail; keep it a sentence, not an essay. */
export const MAX_REJECT_REASON = 500;

// ---------------------------------------------------------------------------
// Text safety
// ---------------------------------------------------------------------------

const MD_ENTITIES: Record<string, string> = {
  "&": "&#38;",
  "<": "&#60;",
  ">": "&#62;",
  "[": "&#91;",
  "]": "&#93;",
  "(": "&#40;",
  ")": "&#41;",
  "*": "&#42;",
  _: "&#95;",
  "~": "&sim;",
  "#": "&#35;",
  "-": "&#45;",
  "`": "&#96;",
};

/** Collapse to one line, drop control characters, cap the length. */
export function oneLine(text: string | null | undefined, max: number): string {
  const flat = String(text ?? "")
    // Control (Cc), format / zero-width (Cf) and line / paragraph separator (Zl, Zp) characters.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/**
 * Escape user text for a markdown element so it renders as plain text.
 * `#` and `-` only mean something at the start of a line (heading, list item,
 * rule) and the text is flattened to one line first, so they are escaped only
 * when they lead: hyphenated names stay readable.
 */
export function escapeLarkMd(text: string | null | undefined, max = 200): string {
  return oneLine(text, max)
    .replace(/[&<>[\]()*_~`]/g, (ch) => MD_ENTITIES[ch] ?? ch)
    .replace(/^[#-]/, (ch) => MD_ENTITIES[ch] ?? ch);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Public base URL for deep links: NEXT_PUBLIC_APP_URL, else the platform's
 * production host on Vercel, else localhost outside production. Returns "" when
 * nothing trustworthy is configured — cards then omit the link rather than
 * point people at a wrong host.
 */
export function resolveAppUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim();
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const raw = configured || (vercel ? `https://${vercel}` : env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  return normalizeAppUrl(raw);
}

export function normalizeAppUrl(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** Where a human can see / decide the request in the NoPM console. */
export function deepLinkFor(appUrl: string, ref: ApprovalRef): string {
  const base = normalizeAppUrl(appUrl);
  if (!base) return "";
  switch (ref.kind) {
    case "change_request":
      return `${base}/change-control?cr=${encodeURIComponent(ref.id)}`;
    case "timesheet":
      return `${base}/timesheets`;
    case "task_deletion":
    case "project_deletion":
      return `${base}/approvals`;
  }
}

// ---------------------------------------------------------------------------
// Frame + element helpers
// ---------------------------------------------------------------------------

/**
 * Can the message-patch API replace this card? Docs: both the original and the
 * replacement must be shared cards (`config.update_multi:true`). Card JSON 2.0
 * only supports shared cards (default true, false unsupported), so a 2.0 card
 * qualifies unless it explicitly says otherwise; a 1.0 card must say so.
 * Every builder below sets `update_multi:true` explicitly, because approval
 * cards are rewritten in place when the request is decided from any channel.
 */
export function isUpdatableCard(card: Record<string, unknown>): boolean {
  const config = card.config && typeof card.config === "object" ? (card.config as { update_multi?: unknown }) : {};
  if (config.update_multi === false) return false;
  return config.update_multi === true || card.schema === "2.0";
}

class ElementIds {
  private n = 0;
  next(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.n}`;
  }
}

function frame(input: { title: string; template: HeaderTemplate; summary: string; elements: Record<string, unknown>[] }): LarkCard {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: oneLine(input.summary, 100) } },
    header: { title: { tag: "plain_text", content: oneLine(input.title, 60) }, template: input.template },
    body: { direction: "vertical", elements: input.elements },
  };
}

function md(ids: ElementIds, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tag: "markdown", element_id: ids.next("md"), content, ...extra };
}

function notation(ids: ElementIds, content: string): Record<string, unknown> {
  return md(ids, content, { text_size: "notation" });
}

function linkLine(ids: ElementIds, label: string, url: string): Record<string, unknown>[] {
  return url ? [md(ids, `[${label}](${url})`)] : [];
}

function plain(content: string) {
  return { tag: "plain_text", content };
}

export function formatUtc(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function statusPresentation(status: string): { label: string; template: HeaderTemplate } {
  switch (status) {
    case "committed":
    case "approved":
      return { label: "Approved", template: "green" };
    case "rejected":
      return { label: "Rejected", template: "red" };
    case "withdrawn":
      return { label: "Withdrawn", template: "grey" };
    default: {
      const label = oneLine(status.replace(/_/g, " "), 40);
      return { label: label ? label.charAt(0).toUpperCase() + label.slice(1) : "Updated", template: "grey" };
    }
  }
}

// ---------------------------------------------------------------------------
// Approval request / decision
// ---------------------------------------------------------------------------

function detailLines(input: { projectName?: string | null; requestedByLabel?: string | null }): string {
  const lines: string[] = [];
  if (input.projectName) lines.push(`**Project:** ${escapeLarkMd(input.projectName, 80)}`);
  if (input.requestedByLabel) lines.push(`**Requested by:** ${escapeLarkMd(input.requestedByLabel, 80)}`);
  return lines.join("\n");
}

/**
 * The actionable card: Approve (one tap) and Reject (a form whose reason is
 * mandatory). Both buttons carry the same single-use token; whichever is
 * pressed first consumes it.
 */
export function buildApprovalRequestCard(ev: ApprovalEvent, ctx: { actionToken: string; appUrl: string }): LarkCard {
  const ids = new ElementIds();
  const kind = KIND_LABEL[ev.kind];
  const isDeletion = ev.kind === "task_deletion" || ev.kind === "project_deletion";
  const elements: Record<string, unknown>[] = [md(ids, `**${escapeLarkMd(ev.title, 200)}**`)];

  const details = detailLines(ev);
  if (details) elements.push(md(ids, details));
  if (ev.summary) elements.push(md(ids, `> ${escapeLarkMd(ev.summary, 400)}`));

  // Lark only honours `confirm` on form-submit buttons, so a dialog on this tap would never
  // appear: say what Approve does on the card itself instead.
  if (isDeletion) elements.push(notation(ids, "Approving carries out the deletion in NoPM."));
  elements.push({
    tag: "button",
    element_id: ids.next("approve"),
    text: plain("Approve"),
    type: "primary_filled",
    size: "medium",
    behaviors: [{ type: "callback", value: { t: ctx.actionToken, a: "approve" } }],
  });

  elements.push({
    tag: "form",
    element_id: ids.next("form"),
    name: "reject_form",
    direction: "vertical",
    elements: [
      {
        tag: "input",
        element_id: ids.next("reason"),
        name: "reason",
        required: true,
        input_type: "multiline_text",
        rows: 2,
        max_length: MAX_REJECT_REASON,
        width: "fill",
        label: plain("Reason (required to reject)"),
        placeholder: plain("Why is this being rejected?"),
      },
      {
        tag: "button",
        element_id: ids.next("reject"),
        name: "reject_submit",
        form_action_type: "submit",
        text: plain("Reject"),
        type: "danger",
        behaviors: [{ type: "callback", value: { t: ctx.actionToken, a: "reject" } }],
      },
    ],
  });

  elements.push(...linkLine(ids, "Open in NoPM", deepLinkFor(ctx.appUrl, { kind: ev.kind, id: ev.id })));
  elements.push(notation(ids, "Your decision is recorded in NoPM's audit log. You cannot approve a request you raised."));

  return frame({
    title: `${kind}: approval needed`,
    template: "orange",
    summary: `${kind}: ${oneLine(ev.title, 80)}`,
    elements,
  });
}

export type DecidedCardInput = {
  ref: ApprovalRef;
  title: string;
  /** Request status after the decision, e.g. "committed" | "approved" | "rejected" | "withdrawn". */
  status: string;
  projectName?: string | null;
  requestedByLabel?: string | null;
  decidedByLabel?: string | null;
  /** Audit channel of the decision ("lark", "ui", "cli", …). */
  channel?: string | null;
  decidedAt?: string | Date | null;
  appUrl: string;
};

/** The closed state: no buttons, who/how/when, link back. Replaces the actionable card. */
export function buildDecidedCard(input: DecidedCardInput): LarkCard {
  const ids = new ElementIds();
  const { label, template } = statusPresentation(input.status);
  const kind = KIND_LABEL[input.ref.kind];
  const elements: Record<string, unknown>[] = [md(ids, `**${escapeLarkMd(input.title, 200)}**`)];

  const details = detailLines(input);
  if (details) elements.push(md(ids, details));

  const lines = [`**Status:** ${escapeLarkMd(label, 40)}`];
  const via = input.channel ? (CHANNEL_LABEL[input.channel] ?? escapeLarkMd(input.channel, 30)) : "";
  const who = input.decidedByLabel ? escapeLarkMd(input.decidedByLabel, 80) : "";
  const when = formatUtc(input.decidedAt);
  if (who || via || when) {
    lines.push(`Decided${who ? ` by **${who}**` : ""}${via ? ` via ${via}` : ""}${when ? ` · ${when}` : ""}`);
  }
  elements.push(md(ids, lines.join("\n")));
  elements.push(...linkLine(ids, "Open in NoPM", deepLinkFor(input.appUrl, input.ref)));

  return frame({ title: `${kind}: ${label.toLowerCase()}`, template, summary: `${kind} ${label.toLowerCase()}: ${oneLine(input.title, 80)}`, elements });
}

/** Rendering of `emitApprovalDecided` for every card already sent about this request. */
export function buildDecisionUpdateCard(ev: ApprovalDecidedEvent, ctx: { appUrl: string; decidedAt?: string | Date | null }): LarkCard {
  return buildDecidedCard({
    ref: { kind: ev.kind, id: ev.id },
    title: ev.title,
    status: ev.status,
    projectName: ev.projectName,
    requestedByLabel: ev.requestedByLabel,
    decidedByLabel: ev.decidedByLabel,
    channel: ev.channel,
    decidedAt: ctx.decidedAt ?? null,
    appUrl: ctx.appUrl,
  });
}

/**
 * What an approval card is patched to when its request was EDITED after the card
 * went out: no buttons, a clear "this is not what you would be approving" notice
 * and the pointer to the replacement. The old content is deliberately not shown.
 */
export function buildChangedUpdateCard(ev: ApprovalEvent, ctx: { appUrl: string }): LarkCard {
  const ids = new ElementIds();
  const kind = KIND_LABEL[ev.kind];
  const elements: Record<string, unknown>[] = [
    md(ids, `**${escapeLarkMd(ev.title, 200)}**`),
    md(ids, "This request was edited after this card was sent, so it can no longer be approved or rejected from here. A new card with the current details follows."),
  ];
  elements.push(...linkLine(ids, "Open in NoPM", deepLinkFor(ctx.appUrl, { kind: ev.kind, id: ev.id })));
  return frame({
    title: `${kind}: updated, see the new card`,
    template: "orange",
    summary: `${kind} updated: ${oneLine(ev.title, 80)}`,
    elements,
  });
}

/** The single roll-up an approver gets once they hit the hourly card budget. */
export function buildBacklogNoticeCard(input: { waiting: number; limit: number; appUrl: string }): LarkCard {
  const count = Number.isFinite(input.waiting) && input.waiting > 0 ? Math.floor(input.waiting) : 0;
  const lead = count > 0 ? `**${count}** approval${count === 1 ? " is" : "s are"} waiting for you in NoPM.` : "More approvals are waiting for you in NoPM.";
  return buildNoticeCard({
    tone: "warning",
    title: "More approvals waiting",
    lines: [
      lead,
      `To keep this chat readable I send at most ${input.limit} approval cards an hour. The rest are in NoPM, where you can decide them.`,
    ],
    appUrl: input.appUrl ? `${normalizeAppUrl(input.appUrl)}/approvals` : "",
    linkLabel: "Open approvals",
  });
}

/** Sent to the OLD Lark account when a link code moves a NoPM user's link to another account. */
export function buildLinkReplacedCard(input: { appUrl: string }): LarkCard {
  return buildNoticeCard({
    tone: "warning",
    title: "This Lark account was unlinked",
    lines: [
      "Your NoPM user was just linked to a different Lark account, so approval requests will no longer come to this chat.",
      "If that was not you, open NoPM now, unlink the new account under Integrations, and ask an admin to review.",
    ],
    appUrl: input.appUrl,
    linkLabel: "Open NoPM",
  });
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

const HEALTH_DOT: Record<string, string> = {
  green: "<font color=green>●</font>",
  amber: "<font color=orange>●</font>",
  red: "<font color=red>●</font>",
  complete: "<font color=grey>●</font>",
  not_started: "<font color=grey>○</font>",
};

const DIGEST_MAX_PROJECTS = 10;
const DIGEST_MAX_MILESTONES = 8;

export function buildDigestCard(data: DigestData): LarkCard {
  const ids = new ElementIds();
  const elements: Record<string, unknown>[] = [];

  const stats = [
    `**${data.projects.length}** project${data.projects.length === 1 ? "" : "s"}`,
    `**${data.openHighRisks}** open high risk${data.openHighRisks === 1 ? "" : "s"}`,
    `**${data.pendingApprovals}** pending approval${data.pendingApprovals === 1 ? "" : "s"}`,
  ];
  elements.push(md(ids, stats.join(" · ")));

  if (data.projects.length === 0) {
    elements.push(md(ids, "**Projects**\nNo projects yet."));
  } else {
    const shown = data.projects.slice(0, DIGEST_MAX_PROJECTS);
    const lines = shown.map((p) => {
      const dot = HEALTH_DOT[p.health ?? ""] ?? "<font color=grey>○</font>";
      const status = p.status ? ` — ${escapeLarkMd(p.status.replace(/_/g, " "), 30)}` : "";
      return `${dot} ${escapeLarkMd(p.name, 60)}${status}`;
    });
    const more = data.projects.length - shown.length;
    if (more > 0) lines.push(`+${more} more in NoPM`);
    elements.push(md(ids, `**Projects**\n${lines.join("\n")}`));
  }

  if (data.milestonesDueSoon.length > 0) {
    const shown = data.milestonesDueSoon.slice(0, DIGEST_MAX_MILESTONES);
    const lines = shown.map((m) => {
      const project = m.projectName ? ` · ${escapeLarkMd(m.projectName, 40)}` : "";
      return `${escapeLarkMd(m.name, 60)}${project} · due ${escapeLarkMd(String(m.dueDate).slice(0, 10), 12)}`;
    });
    const more = data.milestonesDueSoon.length - shown.length;
    if (more > 0) lines.push(`+${more} more in NoPM`);
    elements.push(md(ids, `**Milestones due soon**\n${lines.join("\n")}`));
  } else {
    elements.push(md(ids, "**Milestones due soon**\nNothing due in the next two weeks."));
  }

  elements.push(...linkLine(ids, "Open NoPM", normalizeAppUrl(data.appUrl)));
  const stamp = formatUtc(data.generatedAt);
  if (stamp) elements.push(notation(ids, `Generated ${stamp}`));

  return frame({
    title: `Weekly digest · ${oneLine(data.workspaceName, 40)}`,
    template: "blue",
    summary: `${data.projects.length} projects · ${data.openHighRisks} open high risks · ${data.pendingApprovals} pending approvals`,
    elements,
  });
}

// ---------------------------------------------------------------------------
// Bot replies
// ---------------------------------------------------------------------------

/** `lines` are markdown: callers escape any user-supplied text with `escapeLarkMd`. */
export function buildNoticeCard(input: {
  tone: "info" | "success" | "warning" | "error";
  title: string;
  lines: string[];
  appUrl?: string;
  linkLabel?: string;
}): LarkCard {
  const ids = new ElementIds();
  const template: HeaderTemplate = { info: "blue", success: "green", warning: "orange", error: "red" }[input.tone] as HeaderTemplate;
  const elements = input.lines.map((line) => md(ids, line));
  if (input.appUrl) elements.push(...linkLine(ids, input.linkLabel ?? "Open NoPM", normalizeAppUrl(input.appUrl)));
  // `summary` is the plain-text chat-list preview; `lines` are markdown, so it is the title.
  return frame({ title: input.title, template, summary: input.title, elements });
}

export function buildLinkConfirmationCard(input: { displayName?: string | null; appUrl: string }): LarkCard {
  const who = input.displayName ? ` as **${escapeLarkMd(input.displayName, 60)}**` : "";
  return buildNoticeCard({
    tone: "success",
    title: "Account linked",
    lines: [
      `Your Lark account is now linked to NoPM${who}.`,
      "Approval requests you are eligible to decide will arrive here. Send `help` to see what I understand.",
    ],
    appUrl: input.appUrl,
    linkLabel: "Open NoPM",
  });
}

export function buildHelpCard(appUrl: string): LarkCard {
  return buildNoticeCard({
    tone: "info",
    title: "NoPM bot",
    lines: [
      "**help**: show this message",
      "**link NPL-XXXX-XXXX**: link your Lark account to NoPM (create the code in NoPM under Integrations)",
      "**approvals**: list the requests waiting for your decision",
      "Approval requests arrive here as cards with Approve and Reject buttons.",
    ],
    appUrl,
  });
}

export function buildUnlinkedCard(appUrl: string): LarkCard {
  return buildNoticeCard({
    tone: "warning",
    title: "Account not linked",
    lines: [
      "Your Lark account is not linked to a NoPM user yet.",
      "In NoPM open Integrations, choose Link my account, then send `link NPL-XXXX-XXXX` (your code) here. Codes last 10 minutes.",
    ],
    appUrl,
  });
}

/**
 * Answer to the `approvals` command: how many requests wait on THIS person
 * (same sources + four-eyes exclusion as the console's pending badges). Counts,
 * not titles: the decision itself happens on the card the bot already sent, or
 * in NoPM.
 */
export function buildPendingApprovalsCard(input: { deletions: number; changeRequests: number; appUrl: string }): LarkCard {
  const ids = new ElementIds();
  const base = normalizeAppUrl(input.appUrl);
  const total = input.deletions + input.changeRequests;
  const elements: Record<string, unknown>[] = [];
  if (total === 0) {
    elements.push(md(ids, "Nothing is waiting for your decision."));
  } else {
    const row = (label: string, count: number, path: string) =>
      `**${label}:** ${count}${base && count > 0 ? ` ([open](${base}${path}))` : ""}`;
    elements.push(
      md(
        ids,
        [row("Deletion requests", input.deletions, "/approvals"), row("Change requests", input.changeRequests, "/change-control")].join("\n"),
      ),
    );
    elements.push(notation(ids, "Decide from the approval card I sent you, or open NoPM. Timesheets and other reviews are under Review in NoPM."));
  }
  return frame({
    title: "Waiting for you",
    template: total === 0 ? "green" : "orange",
    summary: total === 0 ? "Nothing waiting" : `${total} waiting for your decision`,
    elements,
  });
}

// ---------------------------------------------------------------------------
// Callback response
// ---------------------------------------------------------------------------

export function cardCallbackResponse(type: ToastType, content: string, card?: LarkCard): CardCallbackResponse {
  return { toast: { type, content: oneLine(content, 200) }, ...(card ? { card: { type: "raw", data: card } } : {}) };
}
