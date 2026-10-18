import { NotFoundError, PreconditionFailedError, RuleError, ScopeError } from "@/lib/api/errors";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/auth/guard";
import { auditedUpdate } from "@/lib/audit/audited-write";

type Db = ReturnType<typeof createAdminClient>;

export const DECISION_ACCEPT_MESSAGE = "Only a manager or admin can mark a decision accepted.";
export const DECISION_LOCKED_MESSAGE =
  "Accepted decisions cannot be edited. Record a new decision that replaces this one.";
export const DECISION_NO_DELETE_MESSAGE =
  "Decisions cannot be deleted. Record a new decision that replaces this one.";

/** The role of the human behind the caller (session user, or the PAT's creator). */
export function callerRole(actor: Actor): string | null {
  const r = actor.type === "user" ? actor.role : actor.principalRole;
  return r ?? null;
}

export function isApproverRole(actor: Actor): boolean {
  const r = callerRole(actor);
  return r === "admin" || r === "manager";
}

/** Decision 25 / Q-REV-18: only managers and admins can mark a decision accepted (or superseded). */
export function assertMayAccept(actor: Actor, status: string | undefined): void {
  if ((status === "accepted" || status === "superseded") && !isApproverRole(actor)) {
    throw new ScopeError(DECISION_ACCEPT_MESSAGE, "role_not_permitted");
  }
}

/** Frozen once accepted (or replaced): content never changes after the decision is on record. */
export function isFrozen(status: string | null | undefined): boolean {
  return status === "accepted" || status === "superseded";
}

/**
 * Q-GOV-15: refuse a supersede link that would loop. Walks the chain upward from
 * the decision being replaced; reaching `selfId` (or revisiting a node) is a loop.
 */
export async function assertNoSupersedeLoop(
  db: Db,
  workspaceId: string,
  replacedId: string,
  selfId: string | null,
): Promise<void> {
  const loop = () =>
    new RuleError(
      "That would create a loop: the decision you are replacing already replaces this one.",
      "supersede_loop",
    );
  const seen = new Set<string>();
  let cur: string | null = replacedId;
  while (cur) {
    if (cur === selfId || seen.has(cur)) throw loop();
    seen.add(cur);
    const res: { data: { supersedes: string | null } | null } = await db
      .from("decisions")
      .select("supersedes")
      .eq("id", cur)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    cur = res.data?.supersedes ?? null;
    if (seen.size > 1000) throw loop();
  }
}

/**
 * Q-GOV-15: when a decision is accepted and replaces an earlier one, the earlier
 * accepted one is marked superseded automatically (one audit row).
 */
export async function markReplacedSuperseded(
  db: Db,
  actor: Actor,
  replacedId: string,
  replacedBy: string,
): Promise<void> {
  const { data: old } = await db
    .from("decisions")
    .select("*")
    .eq("id", replacedId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (!old || old.status !== "accepted") return;
  // One transaction with its audit row. The row must still be the one just read: if it changed
  // since (a concurrent edit), nothing is superseded and no audit row is written.
  try {
    await auditedUpdate({
      table: "decisions",
      actor,
      action: "decision.supersede",
      id: replacedId,
      patch: { status: "superseded" },
      expectedUpdatedAt: (old.updated_at as string | undefined) ?? null,
      afterExtra: { superseded_by: replacedBy },
    });
  } catch (e) {
    if (e instanceof PreconditionFailedError || e instanceof NotFoundError) return;
    throw e;
  }
}
