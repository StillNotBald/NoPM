import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ok, noContent, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { auditedUpdate, auditedDelete } from "@/lib/audit/audited-write";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClashSchema, patchClashSchema } from "../_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { assertNoDuplicateLiveClash, duplicateClashMessage } from "@/lib/clash/duplicate";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { RESOLVE_CLASH_MESSAGE, requireManagerOrAdmin } from "@/lib/work/roles";

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
  const unknown = unknownFieldsResponse(body, createClashSchema);
  if (unknown) return unknown;
  const parsed = patchClashSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid clash payload",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  // Cross-tenant guard (see POST /api/clashes).
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "projects", id: parsed.data.project_a_id, field: "project_a_id" },
    { table: "projects", id: parsed.data.project_b_id, field: "project_b_id" },
    { table: "resource_members", id: parsed.data.resource_member_id, field: "resource_member_id" },
    { table: "profiles", id: parsed.data.owner_id, field: "owner_id" },
  ]);

  // Q-WRK-21: the planner decides — closing a clash by hand (including accepting
  // it with a reason in `resolution`) is for managers and admins. The automatic
  // close when an over-allocation is fixed (lib/clash/detect.ts) is audited
  // separately as clash.auto_resolve.
  if (parsed.data.status === "resolved" && existing.status !== "resolved") {
    requireManagerOrAdmin(actor, RESOLVE_CLASH_MESSAGE);
  }

  // Q-WRK-2: moving a clash onto a person/type (or reopening it) must not create
  // a second live clash for the same person and type.
  const merged = { ...existing, ...parsed.data };
  if (
    parsed.data.resource_member_id !== undefined ||
    parsed.data.type !== undefined ||
    parsed.data.status !== undefined
  ) {
    await assertNoDuplicateLiveClash(db, actor.workspaceId, merged, params.id);
  }

  // Row and audit row are one transaction (nopm_mutate_audited).
  let updated;
  try {
    ({ after: updated } = await auditedUpdate({
      table: "clashes",
      actor,
      action: "clash.update",
      id: params.id,
      patch: { ...parsed.data },
      notFoundMessage: "Clash not found",
    }));
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      throw new RuleError(duplicateClashMessage(String(merged.type), null), "duplicate_clash");
    }
    throw error;
  }

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

  // Row and audit row are one transaction (nopm_mutate_audited).
  await auditedDelete({
    table: "clashes",
    actor,
    action: "clash.delete",
    id: params.id,
    notFoundMessage: "Clash not found",
  });

  return noContent();
});
