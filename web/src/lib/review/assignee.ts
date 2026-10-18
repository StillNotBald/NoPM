/**
 * Optional approver assignment (audit gap G5).
 *
 * A maker-checker request (change request, rebaseline, task or project deletion)
 * may name the one approver it is waiting for, so the pending queue can show
 * "assigned to me". Assignment is routing information only: it never widens who may
 * decide (the decision routes still demand the approver role, the decide scope and
 * four-eyes) and nothing is assigned automatically in this wave.
 *
 * The named person must be an admin or manager of the SAME workspace, and must not
 * be the requester (four-eyes would stop them deciding it). Anything else is a 422
 * with `fields`, thrown so every raise path shares one rule.
 */
import { z } from "zod";
import type { createAdminClient } from "@/lib/supabase/admin";
import { FieldsError } from "@/lib/api/errors";

type Db = ReturnType<typeof createAdminClient>;

/** Zod field for the four raise schemas: a profile id, or null/absent for "nobody in particular". */
export const assignedApproverIdField = z
  .string()
  .uuid("assigned_approver_id must be a profile id")
  .nullable()
  .optional();

export const ASSIGNEE_ROLES = ["admin", "manager"] as const;

/** Returns the validated profile id, or null when none was asked for. Throws FieldsError (422) otherwise. */
export async function resolveAssignedApprover(
  db: Db,
  workspaceId: string,
  assignedApproverId: string | null | undefined,
  requesterPrincipalId: string | null,
  /** G2: the role the request's tier asks of its decider; an assignee below it is refused. */
  requiredRole: "manager" | "admin" = "manager",
): Promise<string | null> {
  if (!assignedApproverId) return null;
  const fail = (message: string): never => {
    throw new FieldsError("Validation failed", [{ field: "assigned_approver_id", message }], "invalid_assigned_approver");
  };
  if (requesterPrincipalId && assignedApproverId === requesterPrincipalId) {
    fail("You cannot assign a request to yourself: four-eyes needs a different person to decide it.");
  }
  const { data, error } = await db
    .from("profiles")
    .select("id, role")
    .eq("id", assignedApproverId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(`assignee lookup failed: ${error.message}`);
  // A person from another workspace and a person who does not exist read the same.
  if (!data || !(ASSIGNEE_ROLES as readonly string[]).includes(data.role as string)) {
    fail("assigned_approver_id must be an admin or manager of this workspace.");
  }
  if (requiredRole === "admin" && data?.role !== "admin") {
    fail("This request needs an admin to decide it, so only an admin can be assigned.");
  }
  return assignedApproverId;
}
