import { route } from "@/lib/api/handler";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";
import { feedOwner, isFeedAdmin } from "@/lib/calendar/feeds";

export const runtime = "nodejs";

const SAFE_COLUMNS =
  "id, name, project_id, created_by, created_at, last_fetched_at, revoked_at" as const;

// DELETE /api/calendar-feeds/[id] — revoke a feed (owner or workspace admin; a session needs no scope, a token needs milestone:write)
// Revocation is soft: the row stays for the audit trail, and the public feed
// route stops serving it at once.
export const DELETE = route(async ({ actor, params }) => {
  // A signed-in person can always revoke their OWN feed, even after being demoted to
  // viewer (Q-ACC-19): revoking only shuts a link, it never writes work data. Tokens
  // keep the scope check. Ownership / admin is enforced below either way.
  if (actor.type === "token") requireScope(actor, "milestone:write");

  const db = createAdminClient();

  const { data: feed, error: fetchError } = await db
    .from("calendar_feeds")
    .select(SAFE_COLUMNS)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!feed) throw new NotFoundError("Calendar feed not found");

  // Four-eyes is not involved here, but a teammate's feed is still theirs:
  // only the creator or a workspace admin may revoke it.
  const owner = feedOwner(actor);
  const isOwner = owner !== null && feed.created_by === owner;
  const isAdmin = isFeedAdmin(actor);
  if (!isOwner && !isAdmin) {
    throw new ScopeError("Only the feed's owner or a workspace admin can revoke it");
  }

  // Revoking twice is a refused request, not a second audit row.
  if (feed.revoked_at) throw new RuleError("Calendar feed is already revoked", "already_revoked");

  // Compare-and-set on revoked_at, so two concurrent revokes cannot both
  // write an audit row for the same change.
  const { data: updated, error: updateError } = await db
    .from("calendar_feeds")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .is("revoked_at", null)
    .select(SAFE_COLUMNS)
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updated) throw new RuleError("Calendar feed is already revoked", "already_revoked");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "calendar_feed.revoke",
    targetType: "calendar_feed",
    targetId: params.id,
    before: feed,
    after: updated,
  });

  return ok(updated);
});
