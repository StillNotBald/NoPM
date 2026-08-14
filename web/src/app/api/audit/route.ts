import { route } from "@/lib/api/handler";
import { okList, validationError } from "@/lib/api/response";
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

  const { limit, page } = parsed.data;
  const offset = (page - 1) * limit;
  const filters = parseAuditFilters(searchParams);

  const db = createAdminClient();

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

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});
