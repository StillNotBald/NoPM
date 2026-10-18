import { route } from "@/lib/api/handler";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { assertMemberAdminSession, restoreMember } from "@/lib/people/members";
import { restoreSchema } from "../../_schema";

export const runtime = "nodejs";

// POST /api/members/[id]/restore { role? } - admin brings a removed person back (same profile, same history).
export const POST = route(async ({ actor, params, request }) => {
  await assertMemberAdminSession(actor);
  const parsed = restoreSchema.safeParse((await safeJson(request)) ?? {});
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }
  const result = await restoreMember(actor, params.id, parsed.data.role ?? null);
  return ok(result.member ?? { id: params.id, status: "active", already_restored: true });
});
