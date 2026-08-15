import { route } from "@/lib/api/handler";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { assertCanManageInvites, assertRevocable } from "@/lib/governance/invite-guard";

export const runtime = "nodejs";

const SAFE_COLUMNS =
  "id, email, role, name, role_title, cost_rate, capacity_hours_per_week, prefix, created_by, created_at, expires_at, revoked, accepted_at, accepted_profile_id" as const;

/**
 * POST /api/invites/[id]/revoke — same admin/manager gate as create (D5).
 * Only a pending invite may be revoked (422 otherwise) — an already-
 * accepted or already-revoked invite has nothing left to revoke.
 */
export const POST = route(async ({ actor, params }) => {
  assertCanManageInvites(actor);

  const db = createAdminClient();

  const { data: invite, error: loadError } = await db
    .from("invites")
    .select("id, revoked, accepted_at, expires_at, email, role")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (loadError) throw loadError;
  if (!invite) throw new NotFoundError("Invite not found");

  assertRevocable(invite);

  const { data: updated, error } = await db
    .from("invites")
    .update({ revoked: true })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select(SAFE_COLUMNS)
    .single();

  if (error || !updated) throw error ?? new Error("Failed to revoke invite");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "invite.revoked",
    targetType: "invite",
    targetId: invite.id,
    before: { email: invite.email, role: invite.role, revoked: false },
    after: { email: invite.email, role: invite.role, revoked: true },
  });

  return ok({ ...updated, status: "revoked" });
});
