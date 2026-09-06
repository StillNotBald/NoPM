import { route } from "@/lib/api/handler";
import { okList, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";
import { parseAuditFilters } from "./_query";

export const runtime = "nodejs";

const querySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? parseInt(v, 10) : 50))
    .pipe(z.number().int().min(1).max(100)),
  page: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? parseInt(v, 10) : 1))
    .pipe(z.number().int().min(1)),
  // R-85 (audit cursor): `since` and `order` get STRICT validation here
  // (422 on a bad value) — unlike parseAuditFilters's lenient extraction,
  // which the export route also relies on and which just drops a bad value
  // instead of failing the whole request. This route is the interactive/
  // agent-facing "tail the log" surface, so a typo'd timestamp or order
  // should come back as a loud 422, not a silently-ignored filter.
  since: z
    .string()
    .optional()
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
      message: "since must be a parsable ISO 8601 timestamp",
    }),
  order: z.enum(["asc", "desc"]).optional(),
  // Format-checked here (422 on a non-UUID); existence within the
  // workspace is checked below with a DB read (404 if absent) since that
  // needs the actor's workspaceId, which zod has no access to.
  after_id: z.string().uuid().optional(),
});

export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "audit:read");

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const { limit, page, after_id } = parsed.data;
  const offset = (page - 1) * limit;
  const filters = parseAuditFilters(searchParams);
  const ascending = filters.order === "asc";

  const db = createAdminClient();

  // R-85: after_id is a cursor into THIS workspace's audit log — resolve
  // its created_at first (404 if it doesn't exist, or belongs to another
  // workspace, which must look identical to "doesn't exist" — never leak
  // cross-workspace row existence) so the main query can filter strictly
  // after it.
  let afterCreatedAt: string | undefined;
  if (after_id) {
    const { data: afterRow, error: afterError } = await db
      .from("audit_log")
      .select("created_at")
      .eq("id", after_id)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (afterError) throw afterError;
    if (!afterRow) throw new NotFoundError("after_id not found");
    afterCreatedAt = afterRow.created_at as string;
  }

  let query = db
    .from("audit_log")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId);

  // Applied inline rather than via the generic applyAuditFilters<Q> helper
  // (still used by GET /api/export, which builds its own query the same
  // way) — chaining that generic against this route's already-concrete
  // Supabase builder type blows past TS's type-instantiation depth limit
  // (TS2589). parseAuditFilters is still the single source of truth for
  // which query params are honored; only the mechanical .eq() application
  // is duplicated here.
  if (filters.target_type !== undefined) query = query.eq("target_type", filters.target_type);
  if (filters.target_id !== undefined) query = query.eq("target_id", filters.target_id);
  if (filters.action !== undefined) query = query.eq("action", filters.action);
  if (filters.actor_id !== undefined) query = query.eq("actor_id", filters.actor_id);
  if (filters.channel !== undefined) query = query.eq("channel", filters.channel);
  // since and after_id may be combined — both filters are ANDed (Postgrest
  // chains .gte()/.gt() as AND), so the more restrictive one simply wins.
  if (filters.since !== undefined) query = query.gte("created_at", filters.since);
  if (afterCreatedAt !== undefined) query = query.gt("created_at", afterCreatedAt);

  const { data, error, count } = await query
    .order("created_at", { ascending })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});
