import { route } from "@/lib/api/handler";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { assertMemberAdminSession, changeMemberRole, removeMember } from "@/lib/people/members";
import { changeRoleSchema } from "../_schema";

export const runtime = "nodejs";

// PATCH /api/members/[id] { role } - admin changes a role. The last admin cannot be demoted (422 last_admin).
export const PATCH = route(async ({ actor, params, request }) => {
  await assertMemberAdminSession(actor);
  const parsed = changeRoleSchema.safeParse(await safeJson(request));
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }
  const result = await changeMemberRole(actor, params.id, parsed.data.role);
  return ok(result.member);
});

// DELETE /api/members/[id] - an admin removes a person; anyone may remove themselves (leave).
// Revokes their API tokens, cancels invites they sent, blocks their sign-in. The profile is kept.
export const DELETE = route(async ({ actor, params }) => {
  await assertMemberAdminSession(actor);
  const result = await removeMember(actor, params.id);
  return ok(result);
});
