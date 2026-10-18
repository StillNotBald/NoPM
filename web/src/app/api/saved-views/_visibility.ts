import { ScopeError } from "@/lib/api/errors";
import type { Actor } from "@/lib/auth/guard";
import type { UpdateSavedViewInput } from "./_schema";

/**
 * Pure guard/visibility logic for saved_views, extracted the same way
 * _query.ts extracts filter parsing elsewhere in this app — a single source
 * of truth the route calls inline (never chained onto a concrete Supabase
 * builder, per the TS2589 house rule) AND a directly unit-testable surface
 * for the "personal invisibility" and "protected-403" acceptance criteria
 * (L-41, L-07) that would otherwise only be provable via a live route call.
 */

export type SavedViewRow = {
  id: string;
  workspace_id: string;
  owner_id: string | null;
  scope: "personal" | "shared" | string;
  protected: boolean;
};

/**
 * True iff `actorId` may SEE `view` — i.e. it's shared in the workspace, or
 * `actorId` is its owner. This is the exact predicate the RLS "read
 * saved_views" policy (migration 20260815000035) enforces for session users;
 * token/agent callers bypass RLS via the admin client, so GET routes apply
 * this SAME function server-side (never trust the DB filter alone for a
 * token caller) — see visibilityOrFilter() below for the query-builder form
 * of the identical rule.
 */
export function isVisibleToActor(view: Pick<SavedViewRow, "scope" | "owner_id">, actorId: string): boolean {
  return view.scope === "shared" || view.owner_id === actorId;
}

/**
 * The `.or(...)` filter expression form of isVisibleToActor(), for the list
 * route's admin-client query. actorId always originates from a resolved
 * Actor (guard.ts), never raw user input, so string interpolation here is
 * not a PostgREST-filter-injection surface.
 */
export function visibilityOrFilter(actorId: string): string {
  return `scope.eq.shared,owner_id.eq.${actorId}`;
}

/**
 * True iff `actor` may WRITE (update/delete/share/protect) `view` — its
 * owner, or a workspace admin, mirroring the RLS "write saved_views"
 * policy's owner-or-admin clause for session users. Token/agent actors have
 * no `role` and never own a personal view (POST forces token-created views
 * to scope=shared with owner_id null — see route.ts), so they are gated
 * separately: a token with saved_view:write may manage any SHARED
 * (workspace) view, but can never touch a human's still-personal one even
 * by guessing its id — personal state stays human-only, not just
 * human-owned.
 */
export function canActorMutate(view: Pick<SavedViewRow, "owner_id" | "scope">, actor: Actor): boolean {
  if (actor.type === "token") return view.scope === "shared";
  if (view.owner_id && actor.id === view.owner_id) return true;
  return actor.role === "admin";
}

/**
 * L-07: a protected view rejects a config-changing PATCH with 403 — UNLESS
 * the same PATCH also unprotects it (patch.protected === false), so a
 * single "unprotect and edit" call is allowed without a forced two-step
 * dance. Throws ScopeError (403) — the acceptance criterion's own wording
 * ("reject config PATCH with 403"), not RuleError (422): this is an
 * authorization gate on a still-protected row, not a validation failure.
 */
export function assertConfigMutable(
  view: Pick<SavedViewRow, "protected">,
  patch: Pick<UpdateSavedViewInput, "config" | "protected">,
): void {
  if (view.protected && patch.config !== undefined && patch.protected !== false) {
    throw new ScopeError(
      "This saved view is protected — unprotect it before changing its config",
      "view_protected",
    );
  }
}

/**
 * Which single audit action verb a given PATCH payload maps to. The
 * constitution's "exactly one immutable audit_log row per mutation" and the
 * task spec's fixed verb set (create/update/delete/shared/protected) both
 * mean one PATCH call gets exactly one action name — priority order below
 * picks the most SPECIFIC applicable verb when a caller (unusually) changes
 * more than one governed field in a single call; the UI never does this
 * (Save/Share/Protect are separate controls that each send one concern).
 */
export function resolveAuditAction(patch: UpdateSavedViewInput): "saved_view.protected" | "saved_view.shared" | "saved_view.update" {
  if (patch.protected !== undefined) return "saved_view.protected";
  if (patch.scope !== undefined) return "saved_view.shared";
  return "saved_view.update";
}
