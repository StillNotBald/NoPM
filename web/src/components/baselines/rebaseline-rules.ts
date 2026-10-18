/**
 * Who may do what to a rebaseline in the console (D1, D-16). Display-side
 * mirror of the API: sign-off and apply are for admins and managers only and
 * never for the proposer (by person; a token counts as the person who minted it).
 * The server is the authority and re-checks everything.
 */
export const ROLE_NOTE = "Only managers and admins can approve";
export const PROPOSER_NOTE = "You proposed this. A different manager or admin must sign off and apply it.";

export interface RebaselineActionState {
  canSignoff: boolean;
  canApply: boolean;
  /** Q-GOV-7: the proposer may withdraw their own proposal while it awaits sign-off. */
  canWithdraw: boolean;
  /** Why the viewer has no decide control (shown in place of the buttons); null when they have one or nothing is open. */
  note: string | null;
}

export function rebaselineActionsFor(input: {
  status: string;
  viewerId: string;
  viewerRole: string | null | undefined;
  requestedBy?: string | null;
  requestedPrincipalId?: string | null;
}): RebaselineActionState {
  const open = input.status === "pending_approval" || input.status === "approved";
  if (!open) return { canSignoff: false, canApply: false, canWithdraw: false, note: null };
  const isProposer = input.requestedBy === input.viewerId || input.requestedPrincipalId === input.viewerId;
  const canWithdraw = input.status === "pending_approval" && isProposer && input.viewerRole !== "viewer";
  if (input.viewerRole !== "admin" && input.viewerRole !== "manager") {
    return { canSignoff: false, canApply: false, canWithdraw, note: ROLE_NOTE };
  }
  if (isProposer) {
    return { canSignoff: false, canApply: false, canWithdraw, note: PROPOSER_NOTE };
  }
  return {
    canSignoff: input.status === "pending_approval",
    canApply: input.status === "approved",
    canWithdraw: false,
    note: null,
  };
}
