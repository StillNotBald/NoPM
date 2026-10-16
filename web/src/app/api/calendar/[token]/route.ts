import { after } from "next/server";
import { route } from "@/lib/api/handler";
import { NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken } from "@/lib/auth/tokens";
import { buildMilestoneCalendar, type CalendarMilestone } from "@/lib/calendar/ics";
import { parseFeedSegment, publicBaseUrl } from "@/lib/calendar/feeds";

export const runtime = "nodejs";

type FeedMilestoneRow = {
  id: string;
  project_id: string;
  name: string;
  target_date: string | null;
  status: string;
  completion_pct: number | string;
  description: string | null;
  updated_at: string;
  // PostgREST types an embedded many-to-one as an object, but the supabase-js
  // result type can surface it as a one-element array. Accept both.
  projects: { name: string } | { name: string }[] | null;
};

// Mapped here, not exported: Next route modules may only export handlers and config.
function projectNameOf(projects: FeedMilestoneRow["projects"]): string | null {
  const project = Array.isArray(projects) ? projects[0] : projects;
  return project?.name ?? null;
}

function toCalendarMilestones(rows: FeedMilestoneRow[]): CalendarMilestone[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    target_date: row.target_date,
    status: row.status,
    completion_pct: Number(row.completion_pct),
    description: row.description,
    project_id: row.project_id,
    project_name: projectNameOf(row.projects),
    updated_at: row.updated_at,
  }));
}

/**
 * GET /api/calendar/[token] — the subscription URL calendar apps poll (PLAN D10).
 *
 * auth:false, because the secret in the URL is the credential and a calendar
 * app cannot send a Bearer header. Unknown, malformed and revoked tokens all
 * get the same 404, so the response cannot be used to probe which tokens exist.
 *
 * Not audited per fetch: a calendar polls every few minutes, and a row per poll
 * would bury the real governance events. last_fetched_at records activity, and
 * it is written after the response is sent so the poll is not held up by it.
 */
export const GET = route(
  async ({ request, params }) => {
    const raw = parseFeedSegment(params.token);
    if (!raw) throw new NotFoundError("Calendar feed not found");

    const db = createAdminClient();

    // The lookup is by the secret's hash, which is unique. The workspace comes
    // from the row, and every milestone query below is scoped to it.
    const { data: feed, error: feedError } = await db
      .from("calendar_feeds")
      .select("id, workspace_id, name, project_id, revoked_at")
      .eq("token_hash", hashToken(raw))
      .maybeSingle();

    if (feedError) throw feedError;
    if (!feed || feed.revoked_at) throw new NotFoundError("Calendar feed not found");

    let query = db
      .from("milestones")
      .select(
        "id, project_id, name, target_date, status, completion_pct, description, updated_at, projects(name)",
      )
      .eq("workspace_id", feed.workspace_id)
      .not("target_date", "is", null)
      .order("target_date", { ascending: true })
      .order("id", { ascending: true });

    if (feed.project_id) query = query.eq("project_id", feed.project_id);

    const { data: rows, error: milestoneError } = await query;
    if (milestoneError) throw milestoneError;

    const baseUrl = publicBaseUrl(request);
    const body = buildMilestoneCalendar({
      calName: feed.name,
      host: new URL(baseUrl).host,
      appUrl: baseUrl,
      milestones: toCalendarMilestones(rows ?? []),
    });

    after(async () => {
      const { error } = await db
        .from("calendar_feeds")
        .update({ last_fetched_at: new Date().toISOString() })
        .eq("id", feed.id)
        .eq("workspace_id", feed.workspace_id);
      if (error) {
        console.error("[nopm][calendar] last_fetched_at update failed", {
          feed: feed.id,
          error: error.message,
        });
      }
    });

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "private, max-age=900",
        "Referrer-Policy": "no-referrer",
      },
    });
  },
  { auth: false },
);
