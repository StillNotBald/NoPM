/**
 * Message and keyboard builders for the Telegram connector. Output is Telegram
 * HTML: every dynamic string goes through `esc`, and `callback_data` is built by
 * `cb`, which refuses anything over the Bot API's 64-byte limit.
 */

import { MENU, menuFor, type Role } from "./commands";
import type { InlineKeyboard } from "./http";

export type Rendered = { text: string; keyboard?: InlineKeyboard };

export const MAX_CALLBACK_BYTES = 64;

export function esc(value: unknown, max = 300): string {
  const s = String(value ?? "")
    .replace(/[​-‍⁠﻿‪-‮⁦-⁩]/g, "")
    .slice(0, max);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `callback_data`: a verb, the pending row id and an optional index. Throws when it would not fit. */
export function cb(verb: string, pendingId: string, extra?: string | number): string {
  const data = extra === undefined ? `${verb}:${pendingId}` : `${verb}:${pendingId}:${extra}`;
  if (Buffer.byteLength(data, "utf8") > MAX_CALLBACK_BYTES) throw new Error("callback_data exceeds 64 bytes");
  return data;
}

export const COPY = {
  turnedOff: "This connector is turned off by your workspace admin.",
  moduleOff: "That part of NoPM is turned off in this workspace.",
  slowDown: "Slow down a little, then send that again.",
  expired: "That step expired. Send the command again to start over.",
  cancelled: "Cancelled. Nothing was changed.",
  nothingToCancel: "Nothing to cancel.",
  noAccess: "You do not have access to that.",
  noProject: "You do not have access to that project.",
  tryAgain: "Something went wrong. Try again in a minute, or open NoPM.",
  freeText: "Free-text questions go to your assistant. Add your own model key in Settings.",
  tokenFailed: "That could not be saved: the permission for this step is no longer valid. Send the command again.",
  alreadyLinked: "This Telegram account is already linked to your NoPM user. Nothing changed.",
  selfApproval: "You raised this request, so another approver has to decide it. It stays pending.",
} as const;

export function linkPrompt(): Rendered {
  return {
    text:
      "This Telegram account is not linked to NoPM yet.\n" +
      "In NoPM open <b>Integrations</b>, choose <b>Link my account</b>, then send me <code>/start CODE</code> with the code shown. Codes last 10 minutes.",
  };
}

export function helpCard(role: Role | null, all: boolean): Rendered {
  if (!role) return linkPrompt();
  const items = menuFor(role);
  const lines = items.map((m) => `/${m.n} ${esc(m.name)}${all ? ` - ${esc(m.blurb)}` : ""}`);
  const text = ["<b>NoPM</b>", ...lines, "/0 Help" + (all ? "" : " (/0 all for everything)")];
  if (all) {
    text.push("", "Typed words work too: " + items.map((m) => esc(m.words[0])).join(", ") + ". Send <code>cancel</code> to stop a step.");
    const hidden = MENU.filter((m) => !m.roles.includes(role));
    if (hidden.length) text.push("Not available to your role: " + hidden.map((m) => `/${m.n}`).join(", "));
  }
  return { text: text.join("\n") };
}

export function note(text: string): Rendered {
  return { text: esc(text, 900) };
}

export function confirmKeyboard(pendingId: string): InlineKeyboard {
  return [[{ text: "Confirm", callback_data: cb("y", pendingId) }, { text: "Cancel", callback_data: cb("n", pendingId) }]];
}

export function preview(lines: string[], pendingId: string): Rendered {
  return { text: ["<b>Please confirm</b>", ...lines].join("\n"), keyboard: confirmKeyboard(pendingId) };
}

export function choice(title: string, pendingId: string, verb: string, options: { label: string; value: string | number }[], withCancel = true): Rendered {
  const rows: InlineKeyboard = options.map((o) => [{ text: o.label.slice(0, 60), callback_data: cb(verb, pendingId, o.value) }]);
  if (withCancel) rows.push([{ text: "Cancel", callback_data: cb("n", pendingId) }]);
  return { text: esc(title, 400), keyboard: rows };
}

export function taskList(tasks: { name: string; due_date?: string | null; overdue?: boolean }[]): Rendered {
  if (tasks.length === 0) return { text: "You have no open tasks. Nice." };
  const lines = tasks.map((t) => `${t.overdue ? "! " : ""}${esc(t.name, 80)}${t.due_date ? ` - due ${esc(String(t.due_date).slice(0, 10))}` : ""}`);
  return { text: ["<b>My work</b>", ...lines].join("\n") };
}

export function projectCards(projects: { name: string; health?: string | null; status?: string | null }[]): Rendered {
  if (projects.length === 0) return { text: "No projects yet." };
  const lines = projects.map((p) => `<b>${esc(p.name, 80)}</b> - ${esc(p.health ?? "no health set")}${p.status ? `, ${esc(p.status)}` : ""}`);
  return { text: lines.join("\n") };
}

export function approvalCard(
  req: { title: string; requestedBy: string; reason?: string | null },
  pendingId: string,
  own: boolean,
): Rendered {
  const body = [`<b>${esc(req.title, 120)}</b>`, `Raised by ${esc(req.requestedBy, 60)}`];
  if (req.reason) body.push(`Reason: ${esc(req.reason, 200)}`);
  if (own) return { text: [...body, "You raised this request, so another approver has to decide it."].join("\n") };
  return {
    text: body.join("\n"),
    keyboard: [[{ text: "Approve", callback_data: cb("ap", pendingId) }, { text: "Reject", callback_data: cb("rj", pendingId) }]],
  };
}
