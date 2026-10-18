import { RuleError, ScopeError } from "@/lib/api/errors";
import { auditPrincipalId } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";

export const DOC_APPROVE_MESSAGE =
  "Only a manager or admin other than the author can approve a document.";

/** Fields whose change makes an earlier approval stale (Q-GOV-14: edits return it to draft). */
export const DOC_CONTENT_FIELDS = ["title", "doc_type", "folder", "summary", "body", "external_url"] as const;

export function documentContentChanged(
  existing: Record<string, unknown>,
  input: Record<string, unknown>,
): boolean {
  return DOC_CONTENT_FIELDS.some((f) => input[f] !== undefined && (input[f] ?? null) !== (existing[f] ?? null));
}

/**
 * Decision 25 / Q-GOV-14: marking a document approved is for managers and
 * admins only, and never the document's author. A token is judged by the
 * human behind it (principalRole / principalId).
 */
export function assertMayApproveDocument(actor: Actor, authorId: string | null | undefined): void {
  const role = actor.type === "user" ? actor.role : actor.principalRole;
  if (role !== "admin" && role !== "manager") {
    throw new ScopeError(DOC_APPROVE_MESSAGE, "role_not_permitted");
  }
  const principal = auditPrincipalId(actor);
  if (authorId && principal && authorId === principal) {
    throw new RuleError(DOC_APPROVE_MESSAGE, "author_cannot_approve");
  }
}

/** True when an approved document must fall back to draft because its content or file changed. */
export function approvalIsStale(
  currentStatus: string,
  requestedStatus: string | undefined,
  contentChanged: boolean,
): boolean {
  return currentStatus === "approved" && contentChanged && (requestedStatus === undefined || requestedStatus === "approved");
}
