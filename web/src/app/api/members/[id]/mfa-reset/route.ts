import { route } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { assertMemberAdminSession, resetMemberMfa } from "@/lib/people/members";

export const runtime = "nodejs";

// POST /api/members/[id]/mfa-reset - an admin clears a member's two-step and issues one-time backup codes.
// The codes are in THIS response only (shown once). The member is told in-app.
export const POST = route(async ({ actor, params }) => {
  await assertMemberAdminSession(actor);
  const result = await resetMemberMfa(actor, params.id);
  return ok(result);
});
