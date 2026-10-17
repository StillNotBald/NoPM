/**
 * How a refused governed decision reads in the console.
 *
 * The decision routes answer a refusal with `{ error, code }`. The generic
 * client used to drop the code, so a four-eyes refusal looked like any other
 * 403. `describeRefusal` turns the code into: a plain-words title, what to do
 * next, whether the form can still succeed on retry (`terminal`), and whether
 * the fix is to look at the latest version (`stale` -> offer a refresh).
 *
 * Pure (no React, no network): unit-tested.
 */
import type { ApiError } from "@/lib/api-client";

export interface Refusal {
  /** The route's machine code, or "" when it sent none. */
  code: string;
  title: string;
  /** What happened and what to do next. */
  detail: string;
  /** The same form cannot succeed on retry: replace it with the message. */
  terminal: boolean;
  /** The record moved under the viewer: the next step is to refresh and look again. */
  stale: boolean;
}

type Known = Omit<Refusal, "code">;

/** Codes the decision routes send, with the copy for each. `detail: null` = use the server's message. */
const KNOWN: Record<string, { title: string; detail: string | null; stale?: boolean }> = {
  self_approval: {
    title: "A different person must decide",
    detail: "You raised this (directly or through your token). Ask someone else to decide it.",
  },
  no_principal: {
    title: "This sign-in isn't tied to a person",
    detail: "Only a person can decide a request, and a token with no recorded owner can't. Sign in as yourself.",
  },
  already_decided: {
    title: "Already decided",
    detail: "Someone decided this while you were looking. Refresh to see the outcome.",
    stale: true,
  },
  precondition_failed: {
    title: "This changed after you opened it",
    detail: "It was edited after you loaded it. Refresh to review the latest version, then decide.",
    stale: true,
  },
  project_locked: { title: "The project is locked", detail: null },
  children_changed: { title: "The project has changed", detail: null, stale: true },
  target_changed: { title: "The task changed after this request", detail: null, stale: true },
  timesheet_changed: { title: "The timesheet has changed", detail: null, stale: true },
  forbidden_scope: { title: "You can't decide this", detail: null },
};

/** Codes that mean "the form is fine, fix the input" rather than "this decision is refused". */
const INPUT_CODES = new Set(["validation_failed", "rationale_required"]);

export function describeRefusal(err: unknown, fallback: string): Refusal {
  const apiErr = (err ?? {}) as Partial<ApiError>;
  const code = typeof apiErr.code === "string" ? apiErr.code : "";
  const message = err instanceof Error && err.message ? err.message : fallback;

  const known = KNOWN[code];
  if (known) {
    const view: Known = {
      title: known.title,
      detail: known.detail ?? message,
      terminal: true,
      stale: Boolean(known.stale),
    };
    return { code, ...view };
  }

  // 412 without a code (older routes): the same stale-record case.
  if (apiErr.status === 412) {
    const stale = KNOWN.precondition_failed;
    return { code: "precondition_failed", title: stale.title, detail: stale.detail!, terminal: true, stale: true };
  }

  const fieldLevel = INPUT_CODES.has(code) || (apiErr.fields?.length ?? 0) > 0;
  return {
    code,
    title: fieldLevel ? "Check the form" : "Couldn't record the decision",
    detail: message,
    terminal: false,
    stale: false,
  };
}

/** Field-level messages from a 422 as `{ field: message }`. */
export function fieldMessages(err: unknown): Record<string, string> {
  const fields = (err as Partial<ApiError> | null)?.fields ?? [];
  const map: Record<string, string> = {};
  for (const f of fields) map[f.field] = f.message;
  return map;
}
