import { route } from "@/lib/api/handler";
import { okList, validationError } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";

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
  target_type: z.string().optional(),
  target_id: z.string().optional(),
  action: z.string().optional(),
  actor_id: z.string().optional(),
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

  const { limit, page, target_type, target_id, action, actor_id } = parsed.data;
  const offset = (page - 1) * limit;

  const db = createAdminClient();

  let query = db
    .from("audit_log")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (target_type !== undefined) query = query.eq("target_type", target_type);
  if (target_id !== undefined) query = query.eq("target_id", target_id);
  if (action !== undefined) query = query.eq("action", action);
  if (actor_id !== undefined) query = query.eq("actor_id", actor_id);

  const { data, error, count } = await query;

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});
