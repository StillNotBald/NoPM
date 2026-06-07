import { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/auth/guard";

export type AuditInput = {
  workspaceId: string;
  actor: Actor;
  action: string; // verb.noun, e.g. "task.create"
  targetType: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
};

/**
 * Fail-closed audit write: every mutation MUST produce exactly one audit row.
 * Throws if the row can't be written, so the caller can abort the mutation
 * (no silent writes). Uses the service-role client; the audit_log table is
 * append-only (UPDATE/DELETE blocked at the DB level).
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("audit_log").insert({
    workspace_id: input.workspaceId,
    actor_type: input.actor.type,
    actor_id: input.actor.id,
    actor_label: input.actor.label,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId ?? null,
    before: (input.before as object) ?? null,
    after: (input.after as object) ?? null,
  });
  if (error) {
    throw new Error(`Fail-closed audit write failed: ${error.message}`);
  }
}
