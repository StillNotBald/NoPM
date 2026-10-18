import { after } from "next/server";
import { route } from "@/lib/api/handler";
import { NotFoundError } from "@/lib/api/errors";
import { ipRateKey } from "@/lib/api/client-ip";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceTimeZone } from "@/lib/integrations/time-zone";
import { hashToken } from "@/lib/auth/tokens";
import { buildMilestoneCalendar, type CalendarMilestone } from "@/lib/calendar/ics";
import {
  FEED_MAX_EVENTS,
  FEED_PAGE_SIZE,
  FEED_RATE_PER_FEED,
  FEED_RATE_PER_IP,
  etagMatches,
  feedEtag,
  feedRateCheck,
  feedWindowStart,
  parseFeedSegment,
  publicBaseUrl,
} from "@/lib/calendar/feeds";

export const runtime = "nodejs";

type ProjectEmbed = { name: string; updated_at?: string | null };

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
  projects: ProjectEmbed | ProjectEmbed[] | null;
};

// Mapped here, not exported: Next route modules may only export handlers and config.
function projectOf(projects: FeedMilestoneRow["projects"]): ProjectEmbed | null {
  return (Array.isArray(projects) ? projects[0] : projects) ?? null;
}

function toCalendarMilestones(rows: FeedMilestoneRow[]): CalendarMilestone[] {
  return rows.map((row) => {
    const project = projectOf(row.projects);
    return {
      id: row.id,
      name: row.name,
      target_date: row.target_date,
      status: row.status,
      completion_pct: Number(row.completion_pct),
      description: row.description,
      project_id: row.project_id,
      project_name: project?.name ?? null,
      updated_at: row.updated_at,
      project_updated_at: project?.updated_at ?? null,
    };
  });
}

const FEED_COLUMNS =
  "id, project_id, name, target_date, status, completion_pct, description, updated_at, projects(name, updated_at)";

type Db = ReturnType<typeof createAdminClient>;
type Feed = { id: string; workspace_id: string; project_id: string | null };

/**
 * The feed's milestones: from the window start forward, in date order, paged
 * under a hard cap. PostgREST silently truncates any result at its row ceiling
 * (1,000 on Supabase) with no error, and with an ascending order that keeps the
 * OLDEST rows, so an unbounded query on a long-lived workspace served years of
 * finished milestones and dropped every upcoming one. Bounding the window keeps
 * the near future in; paging below the ceiling and counting makes any remaining
 * cut-off visible instead of silent.
 */
async function loadFeedMilestones(
  db: Db,
  feed: Feed,
  windowStart: string,
): Promise<{ rows: FeedMilestoneRow[]; truncated: boolean }> {
  const page = (from: number, to: number, withCount: boolean) => {
    let query = db
      .from("milestones")
      .select(FEED_COLUMNS, withCount ? { count: "exact" } : undefined)
      .eq("workspace_id", feed.workspace_id)
      .not("target_date", "is", null)
      .gte("target_date", windowStart)
      .order("target_date", { ascending: true })
      .order("id", { ascending: true });
    if (feed.project_id) query = query.eq("project_id", feed.project_id);
    return query.range(from, to);
  };

  const rows: FeedMilestoneRow[] = [];
  const seen = new Set<string>();
  let total: number | null = null;
  while (rows.length < FEED_MAX_EVENTS) {
    const from = rows.length;
    const to = Math.min(from + FEED_PAGE_SIZE, FEED_MAX_EVENTS) - 1;
    const { data, error, count } = await page(from, to, total === null);
    if (error) throw error;
    if (total === null && typeof count === "number") total = count;
    const got = (data ?? []) as unknown as FeedMilestoneRow[];
    // A row written between two pages can shift the boundary: never emit one twice.
    for (const row of got) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        rows.push(row);
      }
    }
    if (got.length === 0) break;
    if (total !== null ? from + got.length >= total : got.length < to - from + 1) break;
  }
  return { rows, truncated: total !== null ? total > rows.length : rows.length >= FEED_MAX_EVENTS };
}

function tooMany(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "Too many requests" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(Math.max(1, retryAfterSeconds)),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * GET /api/calendar/[token] — the subscription URL calendar apps poll (PLAN D10).
 *
 * auth:false, because the secret in the URL is the credential and a calendar
 * app cannot send a Bearer header. Unknown, malformed and revoked tokens all
 * get the same 404, so the response cannot be used to probe which tokens exist.
 *
 * Throttled (route() only limits authenticated callers, so this does it
 * itself): per client address before the token is looked up (when a trustworthy
 * address is available), then per feed. 429 + Retry-After.
 *
 * Revalidation: the body carries a strong ETag (hash of the deterministic
 * serialisation) and honours If-None-Match with a body-less 304.
 *
 * Not audited per fetch: a calendar polls every few minutes, and a row per poll
 * would bury the real governance events. last_fetched_at records activity (also
 * for a 304), and it is written after the response is sent so the poll is not
 * held up by it.
 */
export const GET = route(
  async ({ request, params }) => {
    const raw = parseFeedSegment(params.token);
    if (!raw) throw new NotFoundError("Calendar feed not found");

    const db = createAdminClient();

    // The caller's network, as far as it can be trusted (the same helper the relay and
    // the invite limiter use): behind our own proxy hops, or the platform-supplied
    // address on Vercel. When nothing can be trusted there is no per-address bucket
    // (a caller-writable header would mint a fresh bucket, and a fresh counter row,
    // per request); the per-feed bucket below still applies.
    const address = ipRateKey(request.headers);
    if (address) {
      const byAddress = await feedRateCheck(db, `cal-ip:${address}`, FEED_RATE_PER_IP);
      if (!byAddress.allowed) return tooMany(byAddress.retryAfterSeconds);
    }

    // The lookup is by the secret's hash, which is unique. The workspace comes
    // from the row, and every milestone query below is scoped to it.
    const { data: feed, error: feedError } = await db
      .from("calendar_feeds")
      .select("id, workspace_id, name, project_id, revoked_at")
      .eq("token_hash", hashToken(raw))
      .maybeSingle();

    if (feedError) throw feedError;
    if (!feed || feed.revoked_at) throw new NotFoundError("Calendar feed not found");

    const byFeed = await feedRateCheck(db, `cal:${feed.id}`, FEED_RATE_PER_FEED);
    if (!byFeed.allowed) return tooMany(byFeed.retryAfterSeconds);

    const { rows, truncated } = await loadFeedMilestones(
      db,
      feed,
      feedWindowStart(new Date(), await getWorkspaceTimeZone(feed.workspace_id)),
    );
    if (truncated) {
      console.warn("[nopm][calendar] feed hit the event cap; the far end of the schedule is not included", {
        feed: feed.id,
        cap: FEED_MAX_EVENTS,
      });
    }

    const baseUrl = publicBaseUrl(request);
    const body = buildMilestoneCalendar({
      calName: feed.name,
      host: new URL(baseUrl).host,
      appUrl: baseUrl,
      milestones: toCalendarMilestones(rows),
    });
    const etag = feedEtag(body);

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

    const common = {
      ETag: etag,
      "Cache-Control": "private, max-age=900",
      "Referrer-Policy": "no-referrer",
    };
    if (etagMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: common });
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        ...common,
        ...(truncated ? { "X-NoPM-Feed-Truncated": "1" } : {}),
      },
    });
  },
  { auth: false },
);
