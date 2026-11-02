import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryError } from "@/components/ui/query-error";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getWorkspaceTimeZone } from "@/lib/integrations/time-zone";
import {
  FEED_KINDS,
  FEED_KIND_LABELS,
  gatherChangeFeed,
  groupByDay,
  isFeedKind,
  isUuid,
  zonedDayStartUtc,
  type FeedFilters,
  type FeedRow,
} from "@/lib/changes/feed";

export const metadata = { title: "What changed" };

type SearchParams = { [key: string]: string | string[] | undefined };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const isDay = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const DAY_MS = 24 * 60 * 60 * 1000;

function dayHeading(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function timeOf(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
}

/**
 * R-143 / audit item A5 — "What changed": the audit trail across every
 * project, newest first, grouped by day. Read-only. It reads through the same
 * helper `GET /api/audit` filters with (lib/changes/feed.ts), as the signed-in
 * member (workspace RLS plus an explicit workspace filter). Filters are plain
 * query params on a GET form, so the page needs no client JavaScript.
 */
export default async function ChangesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await db.from("profiles").select("workspace_id").eq("id", user.id).maybeSingle();
  if (!profile) redirect("/login");
  const workspaceId = profile.workspace_id as string;

  const sp = await searchParams;
  const projectParam = first(sp.project);
  const kindParam = first(sp.kind);
  const actorParam = first(sp.actor);
  const fromParam = first(sp.from);
  const toParam = first(sp.to);
  const page = Math.max(1, Number.parseInt(first(sp.page) ?? "1", 10) || 1);

  const timeZone = await getWorkspaceTimeZone(workspaceId);
  const filters: FeedFilters = {};
  if (isUuid(projectParam)) filters.projectId = projectParam;
  if (isFeedKind(kindParam)) filters.kinds = [kindParam];
  if (isUuid(actorParam)) filters.actorId = actorParam;
  if (isDay(fromParam)) filters.from = zonedDayStartUtc(fromParam, timeZone).toISOString();
  if (isDay(toParam)) filters.to = new Date(zonedDayStartUtc(toParam, timeZone).getTime() + DAY_MS).toISOString();

  const [feed, projectsRes, peopleRes] = await Promise.all([
    gatherChangeFeed(db, workspaceId, filters, { page, timeZone }),
    db.from("projects").select("id, code, name").eq("workspace_id", workspaceId).order("code", { ascending: true }).limit(500),
    db.from("profiles").select("id, display_name, email").eq("workspace_id", workspaceId).order("display_name", { ascending: true }).limit(500),
  ]);
  if (feed.error) return <QueryError what="the change feed" message={feed.error} />;

  const projects = (projectsRes.data ?? []) as { id: string; code: string | null; name: string }[];
  const people = (peopleRes.data ?? []) as { id: string; display_name: string | null; email: string | null }[];
  const groups = groupByDay(feed.rows);
  const filtered = Boolean(filters.projectId || filters.kinds || filters.actorId || filters.from || filters.to);
  const lastPage = Math.max(1, Math.ceil(feed.total / feed.pageSize));

  const link = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of [["project", projectParam], ["kind", kindParam], ["actor", actorParam], ["from", fromParam], ["to", toParam]] as const) {
      if (v) q.set(k, v);
    }
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `/changes?${s}` : "/changes";
  };

  return (
    <div className="mx-auto min-w-0 max-w-4xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <PageHeader title="What changed" />

      <form method="get" action="/changes" className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Filter changes">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-ink-muted">
          Project
          <Select name="project" defaultValue={filters.projectId ?? ""} className="w-full min-w-0">
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code ? `${p.code} — ${p.name}` : p.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-ink-muted">
          Kind
          <Select name="kind" defaultValue={kindParam && isFeedKind(kindParam) ? kindParam : ""} className="w-full min-w-0">
            <option value="">All kinds</option>
            {FEED_KINDS.map((k) => (
              <option key={k} value={k}>
                {FEED_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-ink-muted">
          Person
          <Select name="actor" defaultValue={filters.actorId ?? ""} className="w-full min-w-0">
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name || p.email || p.id}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-ink-muted">
          From
          <Input type="date" name="from" defaultValue={isDay(fromParam) ? fromParam : ""} className="w-full min-w-0" />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-ink-muted">
          To
          <Input type="date" name="to" defaultValue={isDay(toParam) ? toParam : ""} className="w-full min-w-0" />
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit">Apply</Button>
          {filtered && (
            <Link href="/changes" className="focus-ring inline-flex min-h-11 items-center px-2 text-sm text-accent hover:underline sm:min-h-0">
              Clear
            </Link>
          )}
        </div>
      </form>

      {groups.length === 0 ? (
        <Card>
          <EmptyState
            purpose={
              filtered
                ? "No matches. Widen the dates or clear a filter."
                : "No changes yet. Every create, edit, approval and delete will appear here."
            }
            docsHref="/trust"
            docsLabel="Open the Trust Center"
          />
        </Card>
      ) : (
        groups.map((g) => (
          <Card key={g.day}>
            <CardHeader>
              <CardTitle>{dayHeading(g.day)}</CardTitle>
              <span className="font-mono text-xs text-ink-muted">
                {g.rows.length} {g.rows.length === 1 ? "change" : "changes"}
              </span>
            </CardHeader>
            <CardBody pad="none">
              <ul className="divide-y divide-border-subtle">
                {g.rows.map((r) => (
                  <ChangeRow key={r.id} row={r} timeZone={timeZone} />
                ))}
              </ul>
            </CardBody>
          </Card>
        ))
      )}

      {filters.projectId && (
        <p className="text-xs text-ink-muted">
          A project filter covers the project and everything under it. Workspace-level records with no project are not included.
        </p>
      )}

      {lastPage > 1 && (
        <nav className="flex items-center justify-between gap-3 text-sm" aria-label="Pages">
          {page > 1 ? (
            <Link href={link(page - 1)} className="focus-ring inline-flex min-h-11 items-center text-accent hover:underline sm:min-h-0">
              Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="font-mono text-xs text-ink-muted">
            Page {page} of {lastPage}
          </span>
          {page < lastPage ? (
            <Link href={link(page + 1)} className="focus-ring inline-flex min-h-11 items-center text-accent hover:underline sm:min-h-0">
              Older
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}

/** One change. Stacked on a phone (who and what on separate lines), one tight line from sm up. */
function ChangeRow({ row, timeZone }: { row: FeedRow; timeZone: string }) {
  const title = row.href ? (
    <Link href={row.href} className="focus-ring min-w-0 break-words font-medium text-ink hover:text-accent hover:underline">
      {row.targetTitle}
    </Link>
  ) : (
    <span className="min-w-0 break-words font-medium text-ink-muted">{row.targetTitle}</span>
  );
  return (
    <li className="flex min-w-0 flex-col gap-1 px-5 py-3 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="font-mono text-xs text-ink-muted sm:w-14 sm:shrink-0">{timeOf(row.createdAt, timeZone)}</span>
      <span className="font-mono text-xs text-ink-muted sm:w-16 sm:shrink-0">{row.projectCode ?? "—"}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-xs text-accent">{row.action}</span>
          {title}
        </div>
        <div className="text-xs text-ink-muted">
          {row.actorLabel}
          {row.onBehalfOf ? ` · via token, for ${row.onBehalfOf}` : ""}
        </div>
      </div>
    </li>
  );
}
