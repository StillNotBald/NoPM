/**
 * lib/review/four-eyes.ts
 *
 * "May THIS signed-in person decide THIS row, and if not, why?" for the
 * console's server-rendered pages (/approvals, /change-control, the review
 * queue). It is a thin adapter over `evaluateDecision` / `requesterOf` in
 * ./pending, the same functions the agent-facing `GET /api/approvals/pending`
 * uses, so the console cannot disagree with the API about who may decide:
 *
 *   - a viewer-role session cannot decide anything (guard.ts `requireScope`);
 *   - a signed-in person is their own principal;
 *   - the requester is compared by actor (legacy) AND by person
 *     (`requested_principal_id`, which a token raises on behalf of its
 *     creator), so a request raised by the viewer's own token is refused.
 *
 * It uses the principal STORED on the row, exactly as the decision routes do
 * (decide.ts `assertNotRequesterPrincipal`): a row without one cannot be
 * compared, and the route lets it through, so this does too.
 *
 * `can_decide` stays advisory (the routes re-check everything and a refusal is
 * rendered by components/governance/refusal.ts), but it is computed from the
 * same inputs so the console no longer offers a button the API will refuse.
 */
import type { DecideState, FourEyesBlock } from "@/components/governance/four-eyes-note";
import { evaluateDecision, requesterOf, type PendingKind, type Requester } from "./pending";

export interface Viewer {
  /** The signed-in profile id (a session user is their own principal). */
  id: string;
  /** profiles.role; "viewer" is read-only. */
  role: string | null;
}

/** Mirrors `requireScope` for a session actor (guard.ts): viewers are read-only. */
const VIEWER_READ_ONLY = "Viewers have read-only access";

/**
 * Columns the verdict needs, per kind. Select these (server-side only) next to
 * the columns a page already reads; never ship them to the browser.
 */
export const REQUESTER_COLUMNS: Readonly<Record<"deletion" | "change" | "timesheet", string>> = {
  deletion: "requested_by_type, requested_by_id, requested_principal_id",
  change: "requested_by, requested_by_type, requested_by_id, requested_principal_id",
  timesheet: "submitted_by, submitted_by_type, submitted_principal_id",
};

function sameActor(viewer: Viewer, requester: Requester): boolean {
  return requester.type === "user" && requester.id === viewer.id;
}

/** D-16: only admins and managers may approve or decide, on every channel. */
export function canDecideByRole(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager";
}

function canWithdrawOwn(viewer: Viewer, kind: PendingKind, row: object): boolean {
  if (kind !== "task_deletion" && kind !== "project_deletion") return false;
  const requester: Requester = requesterOf({ kind, row: row as Record<string, unknown> });
  if (!requester.principal && requester.type === "user") requester.principal = requester.id;
  return sameActor(viewer, requester) || (!!requester.principal && requester.principal === viewer.id);
}

export function judgeDecision(input: {
  viewer: Viewer;
  kind: PendingKind;
  /** The raw table row (needs the REQUESTER_COLUMNS for its kind). */
  row: object;
  /**
   * Timesheets only: the login (profiles.id) of the member whose hours these
   * are. The routes refuse a decision by that person on top of the submitter
   * rule (decide.ts `assertNotTimesheetSubject`).
   */
  subjectProfileId?: string | null;
  /**
   * Deletions only: the project the record lives in is locked, so the commit
   * would be refused (D17). Unlock it or rebaseline first.
   */
  projectLocked?: boolean;
}): DecideState {
  const { viewer, kind, row, subjectProfileId, projectLocked } = input;
  // D-16 (2026-10-17, "follow Lark rules"): deciding is for admins and managers
  // only. Members and viewers never get a decide control; the server refuses
  // them with 403 role_not_permitted.
  if (!canDecideByRole(viewer.role)) {
    return { canDecide: false, block: "role_not_permitted", canWithdraw: canWithdrawOwn(viewer, kind, row) };
  }
  const requester: Requester = requesterOf({ kind, row: row as Record<string, unknown> });
  // Rows from before the principal columns: a user-raised request IS that person.
  if (!requester.principal && requester.type === "user") requester.principal = requester.id;

  const verdict = evaluateDecision({
    actor: { type: "user", id: viewer.id },
    actorPrincipal: viewer.id,
    requester,
    scopeProblem: viewer.role === "viewer" ? VIEWER_READ_ONLY : null,
  });

  // Withdraw cancels (it decides nothing), so the person behind a token or the
  // assistant may do it: same actor OR same human (decide.ts `withdrawDeletion`).
  const canWithdraw =
    (kind === "task_deletion" || kind === "project_deletion") &&
    (sameActor(viewer, requester) || (!!requester.principal && requester.principal === viewer.id));

  if (verdict.can_decide) {
    if (projectLocked && (kind === "task_deletion" || kind === "project_deletion")) {
      return { canDecide: false, block: "project_locked", canWithdraw };
    }
    if (kind === "timesheet" && subjectProfileId && subjectProfileId === viewer.id) {
      return { canDecide: false, block: "your_hours", canWithdraw: false };
    }
    return { canDecide: true, block: null, canWithdraw };
  }

  return { canDecide: false, block: classify(viewer, requester), canWithdraw };
}

/** Which of `evaluateDecision`'s refusals applied, in its own order (scope, then identity, then four-eyes). */
function classify(viewer: Viewer, requester: Requester): FourEyesBlock {
  if (!canDecideByRole(viewer.role)) return "role_not_permitted";
  if (sameActor(viewer, requester)) return "you_raised";
  return requester.type === "token" ? "your_token_raised" : "you_raised";
}

/**
 * Decision 11 / Q-GOV-17: an open change request is edited only by the
 * requester's person, and not at all once decided. Mirrors the API's
 * assertRequester + assertStillOpen (a legacy row with no recorded requester
 * person has nobody to compare with, so the API lets it through).
 */
export function canEditChangeRequest(input: {
  viewerId: string;
  status: string;
  requestedPrincipalId?: string | null;
}): boolean {
  if (input.status !== "raised" && input.status !== "under_review") return false;
  return !input.requestedPrincipalId || input.requestedPrincipalId === input.viewerId;
}

/**
 * Rebaseline sign-off (D1, D-16): admins and managers only, and never the
 * proposer (by person: a token counts as the person who minted it).
 */
export function judgeRebaselineSignoff(
  viewer: Viewer,
  row: { requested_by?: string | null; requested_principal_id?: string | null },
): DecideState {
  if (!canDecideByRole(viewer.role)) return { canDecide: false, block: "role_not_permitted", canWithdraw: false };
  if (row.requested_by === viewer.id || row.requested_principal_id === viewer.id) {
    return { canDecide: false, block: "you_raised", canWithdraw: false };
  }
  return { canDecide: true, block: null, canWithdraw: false };
}
