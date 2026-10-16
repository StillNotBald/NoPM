import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { feedOwner, feedUrl, generateFeedToken, publicBaseUrl } from "@/lib/calendar/feeds";
import { createCalendarFeedSchema } from "./_schema";

export const runtime = "nodejs";

// Columns returned to callers. token_hash is NEVER included, and the raw token
// only ever appears once, inside the `url` returned by POST.
const SAFE_COLUMNS =
  "id, name, project_id, created_by, created_at, last_fetched_at, revoked_at" as const;

// GET /api/calendar-feeds — the caller's own active feeds (milestone:read)
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "milestone:read");

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10) || 20));
  const offset = (page - 1) * limit;

  const owner = feedOwner(actor);
  // A token with no recorded creator owns nothing, so it lists nothing.
  if (!owner) return okList([], { total: 0, page, limit });

  const db = createAdminClient();

  const { count, error: countError } = await db
    .from("calendar_feeds")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId)
    .eq("created_by", owner)
    .is("revoked_at", null);

  if (countError) throw countError;

  const { data, error } = await db
    .from("calendar_feeds")
    .select(SAFE_COLUMNS)
    .eq("workspace_id", actor.workspaceId)
    .eq("created_by", owner)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});

// POST /api/calendar-feeds — mint a feed; the subscription URL is returned ONCE (milestone:write)
export const POST = route(async ({ actor, request }) => {
  // Viewers are refused by requireScope; a read-only token is refused here too.
  requireScope(actor, "milestone:write");

  const owner = feedOwner(actor);
  if (!owner) {
    throw new ScopeError("This token has no recorded owner, so it cannot create a calendar feed");
  }

  const body = await safeJson(request);
  const parsed = createCalendarFeedSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  const db = createAdminClient();
  const projectId = parsed.data.project_id ?? null;

  // A project id from another workspace must not be reachable through a feed.
  if (projectId) {
    const { data: project, error: projectError } = await db
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();

    if (projectError) throw projectError;
    if (!project) {
      return validationError("Validation failed", [
        { field: "project_id", message: "Project not found in this workspace" },
      ]);
    }
  }

  const { raw, hash } = generateFeedToken();

  const { data: row, error } = await db
    .from("calendar_feeds")
    .insert({
      workspace_id: actor.workspaceId, // always from the actor, never the body
      name: parsed.data.name,
      project_id: projectId,
      token_hash: hash,
      created_by: owner,
    })
    .select(SAFE_COLUMNS)
    .single();

  if (error) throw error;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "calendar_feed.create",
    targetType: "calendar_feed",
    targetId: row.id,
    before: null,
    after: row,
  });

  // The raw token exists only in this response, never in the row or the audit trail.
  return created({ ...row, url: feedUrl(publicBaseUrl(request), raw) });
});
