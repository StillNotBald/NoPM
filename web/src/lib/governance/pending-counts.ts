/**
 * lib/governance/pending-counts.ts
 *
 * Server helper: how many governance items are waiting on THIS actor's
 * decision, per queue. Uses the same sources and filters as the pages
 * (review / approvals / change-control / decisions), with an explicit
 * workspace filter (token callers use the admin client, which bypasses RLS)
 * and four-eyes exclusion (items the actor raised themselves can't be
 * decided by them, so they don't count as "needs my decision").
 *
 * Buckets are disjoint so `total` never double-counts:
 *   approvals     deletion_requests pending, not requested by the actor
 *   changeControl change_requests raised|under_review, not requested by the actor
 *   decisions     decisions proposed
 *   review        the review-queue kinds with no dedicated page: rebaselines
 *                 pending_approval (not own), timesheets submitted (not own),
 *                 open high/critical risks, unresolved clashes, documents in_review
 *
 * A failing query (including a not-yet-migrated table) counts as 0 so a
 * nav badge can never take a page down.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PendingCounts {
  review: number;
  approvals: number;
  changeControl: number;
  decisions: number;
  total: number;
}

export interface PendingCountsActor {
  /** profiles.id of the current user (four-eyes exclusion). */
  userId: string;
  workspaceId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;

async function count(build: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  try {
    const { count: n, error } = await build();
    return error ? 0 : (n ?? 0);
  } catch {
    return 0;
  }
}

function head(db: SupabaseClient, table: string, workspaceId: string): Q {
  return db.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
}

export async function getPendingCounts(
  db: SupabaseClient,
  actor: PendingCountsActor,
): Promise<PendingCounts> {
  const { userId, workspaceId } = actor;

  const [approvals, changeControl, decisions, rebaselines, timesheets, risks, clashes, documents] =
    await Promise.all([
      count(() =>
        head(db, "deletion_requests", workspaceId)
          .eq("status", "pending")
          // compound identity: only a user-typed requester equal to me is "own"
          .or(`requested_by_type.neq.user,requested_by_id.neq.${userId}`),
      ),
      count(() =>
        head(db, "change_requests", workspaceId)
          .in("status", ["raised", "under_review"])
          .or(`requested_by.is.null,requested_by.neq.${userId}`),
      ),
      count(() => head(db, "decisions", workspaceId).eq("status", "proposed")),
      count(() =>
        head(db, "rebaselines", workspaceId)
          .eq("status", "pending_approval")
          .or(`requested_by.is.null,requested_by.neq.${userId}`),
      ),
      count(() =>
        head(db, "timesheet_submissions", workspaceId)
          .eq("status", "submitted")
          .or(`submitted_by_type.neq.user,submitted_by.neq.${userId}`),
      ),
      count(() =>
        head(db, "risks", workspaceId)
          .in("severity", ["high", "critical"])
          .not("status", "in", '("closed","accepted")'),
      ),
      count(() => head(db, "clashes", workspaceId).not("status", "in", '("resolved")')),
      count(() => head(db, "documents", workspaceId).eq("status", "in_review")),
    ]);

  const review = rebaselines + timesheets + risks + clashes + documents;
  return { review, approvals, changeControl, decisions, total: review + approvals + changeControl + decisions };
}
