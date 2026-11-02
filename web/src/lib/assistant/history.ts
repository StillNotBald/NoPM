/**
 * Conversation history and interrupted-turn records (audit A3, A4, A9).
 *
 * Pure helpers, no database access: the chat route loads rows and persists
 * what these return. Nothing here needs a new table; the action record lives in
 * the existing `assistant_messages.actions` column.
 */

import type { Action } from "@/lib/agent-core/tool-engine";
import { TOOLS } from "./tools";

/** One message (the user's text, or a stored history entry) is cut at this many characters. */
export const MAX_MESSAGE_CHARS = 8_000;

/** Stored history rows forwarded to the model. */
export const MAX_STORED_HISTORY = 24;

/** Prefix of an assistant row written for a turn that did not finish. */
export const INTERRUPTED_PREFIX = "(interrupted) ";

export type HistoryRow = { role: "user" | "assistant"; content: string; actions?: Action[] | null };
export type HistoryMessage = { role: "user" | "assistant"; content: string };

const WRITE_TOOLS: ReadonlySet<string> = new Set(
  TOOLS.filter((t) => {
    try {
      return t.toRequest({}).method !== "GET";
    } catch {
      return true;
    }
  }).map((t) => t.definition.name),
);

/** True when the action changed (or asked to change) something: a non-GET tool that succeeded. */
export function isExecutedWrite(a: Action): boolean {
  return a.ok && WRITE_TOOLS.has(a.tool);
}

/** Plain-text label: other people wrote record names, so strip markup and cap the length. */
function clean(text: string, max = 80): string {
  return text.replace(/[^\p{L}\p{N} _.,'()&/#:-]/gu, "").slice(0, max);
}

/** "create_task -> id <uuid> 'Name'" for each write action; empty when none. */
export function toolNote(actions: readonly Action[] | null | undefined): string {
  const writes = (actions ?? []).filter(isExecutedWrite);
  if (writes.length === 0) return "";
  const parts = writes.slice(0, 12).map((a) => `${a.tool}${a.entityId ? ` -> id ${a.entityId}` : ""}: ${clean(a.summary)}`);
  return `[tools: ${parts.join("; ")}]`;
}

/** Content of the assistant row saved when a turn stops early but had already acted or spoken. */
export function interruptedContent(actions: readonly Action[], partialReply = ""): string | null {
  const partial = partialReply.trim();
  const done = actions.filter((a) => a.ok).map((a) => clean(a.summary, 120));
  if (done.length === 0 && !partial) return null;
  const doneText = done.length > 0 ? `Done before the error: ${done.join("; ")}.` : "";
  return `${INTERRUPTED_PREFIX}${[partial, doneText].filter(Boolean).join(" ")}`.slice(0, MAX_MESSAGE_CHARS);
}

/**
 * Stored rows -> the history sent to the model. Assistant rows get the tool note
 * appended, so a created id survives to the next turn ("now set its due date").
 * Roles come from the database, so a client can no longer fake an assistant turn.
 */
export function rowsToHistory(rows: readonly HistoryRow[]): HistoryMessage[] {
  return rows.slice(-MAX_STORED_HISTORY).map((r) => {
    const note = r.role === "assistant" ? toolNote(r.actions) : "";
    return { role: r.role, content: `${r.content}${note ? `\n${note}` : ""}`.slice(0, MAX_MESSAGE_CHARS + 600) };
  });
}

/**
 * A retry re-sends a message whose first attempt may already have run tools.
 * Drop that attempt from the history (the trailing assistant row, and the user
 * row when it is the same text) and return what it had done, so the model can
 * be told not to do it twice.
 */
export function splitRetry(
  rows: readonly HistoryRow[],
  message: string,
): { rows: HistoryRow[]; priorActions: Action[]; dropUserRow: boolean } {
  const out = [...rows];
  let priorActions: Action[] = [];
  if (out.length > 0 && out[out.length - 1].role === "assistant") {
    priorActions = (out.pop()!.actions ?? []).filter(Boolean);
  }
  let dropUserRow = false;
  if (out.length > 0 && out[out.length - 1].role === "user" && out[out.length - 1].content.trim() === message.trim()) {
    out.pop();
    dropUserRow = true;
  }
  return { rows: out, priorActions, dropUserRow };
}

/** The system-prompt line for a retry, or null when the first attempt changed nothing. */
export function priorAttemptNote(priorActions: readonly Action[]): string | null {
  const done = priorActions.filter(isExecutedWrite);
  if (done.length === 0) return null;
  const list = done.slice(0, 12).map((a) => `${a.tool}${a.entityId ? ` (id ${a.entityId})` : ""}: ${clean(a.summary)}`).join("; ");
  return (
    `A previous attempt at this same request already did this: ${list}. ` +
    "Do NOT run those again. Tell the user they are done, and carry on only with what is still missing; " +
    "ask before repeating any of them."
  );
}

/** Client-sent history (demo sessions and brand-new conversations only): bounded per entry. */
export function boundClientHistory(history: readonly HistoryMessage[]): HistoryMessage[] {
  return history.slice(-MAX_STORED_HISTORY).map((h) => ({ role: h.role, content: h.content.slice(0, MAX_MESSAGE_CHARS) }));
}
