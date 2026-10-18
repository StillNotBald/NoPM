import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedInsert } from "@/lib/audit/audited-write";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { createSavedViewSchema } from "./_schema";
import { visibilityOrFilter } from "./_visibility";

export const runtime = "nodejs";

/**
 * GET /api/saved-views — list saved views in the actor's workspace
 * (saved_view:read). Returns the caller's OWN personal views plus every
 * shared view in the workspace — never another identity's personal view
 * (L-41). Optional ?register=tasks scopes to one register's views.
 *
 * Session users are additionally protected by RLS's "read saved_views"
 * policy; token/agent callers use the admin client (RLS bypassed), so
 * visibilityOrFilter() is applied explicitly here — this is the exact
 * predicate _visibility.test.ts locks down.
 */
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "saved_view:read");

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10)));
  const offset = (page - 1) * limit;
  const register = searchParams.get("register");

  const db = createAdminClient();

  let countQuery = db
    .from("saved_views")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId)
    .or(visibilityOrFilter(actor.id));
  if (register) countQuery = countQuery.eq("register", register);
  const { count, error: countError } = await countQuery;
  if (countError) throw countError;

  let query = db
    .from("saved_views")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .or(visibilityOrFilter(actor.id));
  if (register) query = query.eq("register", register);
  query = query.order("scope", { ascending: true }).order("updated_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});

/**
 * POST /api/saved-views — create a saved view (saved_view:write).
 *
 * Identity note: owner_id targets profiles(id) — the LOGIN identity, unlike
 * programs.owner_id (resource_members). A Bearer-PAT (token) actor has no
 * profiles row, so a token-authored view is always forced to scope='shared'
 * with owner_id=null regardless of what the caller requested — a token has
 * no private identity to own a personal view WITH (mirrors the DB CHECK
 * `saved_views_personal_needs_owner`, which would otherwise reject the
 * insert outright; this is the friendlier API-layer version of that rule).
 */
export const POST = route(async ({ actor, request }) => {
  requireScope(actor, "saved_view:write");

  const body = await safeJson(request);
  const parsed = createSavedViewSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid saved view data",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const isToken = actor.type === "token";
  const scope = isToken ? "shared" : parsed.data.scope;
  const ownerId = isToken ? null : actor.id;

  const now = new Date().toISOString();
  // Row and audit row are one transaction (nopm_mutate_audited, migration 0103).
  const row = await auditedInsert({
    table: "saved_views",
    actor,
    action: "saved_view.create",
    patch: {
      owner_id: ownerId,
      register: parsed.data.register,
      name: parsed.data.name,
      config: parsed.data.config ?? {},
      scope,
      protected: parsed.data.protected,
      updated_at: now,
    },
  });

  return created(row);
});
