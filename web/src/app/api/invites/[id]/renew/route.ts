import { route } from "@/lib/api/handler";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { assertCanManageInvites, assertCanRevokeCreatedBy, deriveInviteStatus } from "@/lib/governance/invite-guard";

export const runtime = "nodejs";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, same as creation

const SAFE_COLUMNS =
  "id, email, role, name, role_title, cost_rate, capacity_hours_per_week, prefix, created_by, created_at, expires_at, revoked, accepted_at, accepted_profile_id" as const;

/**
 * POST /api/invites/[id]/renew (Q-ACC-25) - give an EXPIRED invite another 7 days.
 * Same admin/manager gate as create/revoke; a manager cannot renew an invite an
 * admin created (Q-ACC-9). The original link works again (the token is unchanged),
 * so the inviter does not have to send a new one. Only an expired invite can be
 * renewed: pending, accepted and revoked ones answer 422.
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

  const status = deriveInviteStatus(invite);
  if (status !== "expired") {
    throw new RuleError(`Only an expired invite can be renewed (status: ${status})`, "not_expired");
  }

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

  // R3-2: a renewed link must never reach an existing account (active or removed).
  const emailPattern = String(invite.email).replace(/[\\%_]/g, (c) => "\\" + c);
  const { data: existingAccount, error: accountError } = await db
    .from("profiles")
    .select("id")
    .eq("workspace_id", actor.workspaceId)
    .ilike("email", emailPattern)
    .limit(1)
    .maybeSingle();
  if (accountError) throw accountError;
  if (existingAccount) {
    throw new RuleError("This email already has an account, so the invite cannot be renewed.", "account_exists");
  }

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const { data: updated, error } = await db
    .from("invites")
    .update({ expires_at: expiresAt })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .eq("revoked", false)
    .is("accepted_at", null)
    .select(SAFE_COLUMNS)
    .single();
  if (error || !updated) throw error ?? new Error("Failed to renew invite");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "invite.renewed",
    targetType: "invite",
    targetId: invite.id,
    before: { email: invite.email, role: invite.role, expires_at: invite.expires_at },
    after: { email: invite.email, role: invite.role, expires_at: expiresAt },
  });

  return ok({ ...updated, status: deriveInviteStatus(updated) });
});
