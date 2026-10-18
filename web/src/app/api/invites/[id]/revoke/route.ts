import { route } from "@/lib/api/handler";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedUpdate } from "@/lib/audit/audited-write";
import { columnsOf, pickColumns } from "@/lib/audit/pick";
import { ok } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { assertCanManageInvites, assertCanRevokeCreatedBy, assertRevocable } from "@/lib/governance/invite-guard";

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
    .select("id, revoked, accepted_at, expires_at, email, role, created_by")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (loadError) throw loadError;
  if (!invite) throw new NotFoundError("Invite not found");

  assertRevocable(invite);

  // Q-ACC-9: a manager cannot revoke an invite an admin created.
  if (invite.created_by && actor.role !== "admin") {
    const { data: creator, error: creatorError } = await db
      .from("profiles")
      .select("role")
      .eq("id", invite.created_by)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (creatorError) throw creatorError;
    assertCanRevokeCreatedBy(actor.role, creator?.role);
  }

  // The update and its audit row are one transaction (nopm_mutate_audited, migration 0103).
  const { after } = await auditedUpdate({
    table: "invites",
    actor,
    action: "invite.revoked",
    id: invite.id,
    patch: { revoked: true },
    notFoundMessage: "Invite not found",
    auditBefore: { email: invite.email, role: invite.role, revoked: false },
    auditAfter: { email: invite.email, role: invite.role, revoked: true },
  });
  const updated = pickColumns(after, columnsOf(SAFE_COLUMNS));

  return ok({ ...updated, status: "revoked" });
});
