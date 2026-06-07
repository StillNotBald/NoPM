import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ok, noContent, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { patchClashSchema } from "../_schema";

export const runtime = "nodejs";

export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "clash:read");

  const db = createAdminClient();
  const { data, error } = await db
    .from("clashes")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("Clash not found");

  return ok(data);
});

export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "clash:write");

  const db = createAdminClient();
  const { data: existing, error: fetchError } = await db
    .from("clashes")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) throw new NotFoundError("Clash not found");

  const body = await safeJson(request);
  const parsed = patchClashSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid clash payload",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  // Strip any id/workspace_id from update payload
  const { data: updated, error: updateError } = await db
    .from("clashes")
    .update({ ...parsed.data })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "clash.update",
    targetType: "clash",
    targetId: params.id,
    before: existing,
    after: updated,
  });

  return ok(updated);
});

export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "clash:write");

  const db = createAdminClient();
  const { data: existing, error: fetchError } = await db
    .from("clashes")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) throw new NotFoundError("Clash not found");

  const { error: deleteError } = await db
    .from("clashes")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw deleteError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "clash.delete",
    targetType: "clash",
    targetId: params.id,
    before: existing,
    after: null,
  });

  return noContent();
});
