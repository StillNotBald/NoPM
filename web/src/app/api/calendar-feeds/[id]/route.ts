import { route } from "@/lib/api/handler";
import { NotFoundError, PreconditionFailedError, RuleError, ScopeError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedUpdate } from "@/lib/audit/audited-write";
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

  // Compare-and-set on revoked_at (requireNull), so two concurrent revokes cannot both
  // write an audit row for the same change. Row and audit row are one transaction
  // (nopm_mutate_audited); the token hash is never read back.
  let written;
  try {
    ({ after: written } = await auditedUpdate({
      table: "calendar_feeds",
      actor,
      action: "calendar_feed.revoke",
      id: params.id,
      patch: { revoked_at: new Date().toISOString() },
      requireNull: "revoked_at",
      omitColumns: ["token_hash", "workspace_id"],
      notFoundMessage: "Calendar feed not found",
    }));
  } catch (error) {
    if (error instanceof PreconditionFailedError) throw new RuleError("Calendar feed is already revoked", "already_revoked");
    throw error;
  }
  const updated = Object.fromEntries(SAFE_COLUMNS.split(", ").map((c) => [c, written[c]]));

  return ok(updated);
});
