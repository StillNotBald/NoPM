import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { ExportCsvButton } from "@/components/export-csv-button";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FilterSheet } from "@/components/ui/filter-sheet";
import { Table, THead, TH, TR, TD } from "@/components/ui/data-table";
import { QueryError } from "@/components/ui/query-error";
import { APPEARANCE_COOKIE_NAME, parseAppearancePrefs } from "@/lib/theme/appearance";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
import { AUDIT_ACTION_GLOSSARY } from "@/lib/audit/action-glossary";
import { cn } from "@/lib/cn";
import { parseAuditFilters } from "@/app/api/audit/_query";

export const metadata = { title: "Trust Center" };

const PAGE_SIZE = 50;

interface AuditRow {
  id: string;
  action: string;
  actor_type: "user" | "token" | string;
  actor_label: string;
  target_type: string;
  target_id: string | null;
  created_at: string;
  meta?: Record<string, unknown> | null;
  /** Declared client (R-82) — caller-asserted via X-NoPM-Client, defaulted
   *  server-side when absent. NOT an authorization input — see the "Actor
   *  types" glossary card below. Nullable: rows written before this column
   *  existed have no channel on file. */
  channel?: "ui" | "api" | "cli" | "mcp" | "assistant" | string | null;
  request_id?: string | null;
}

function shortRequestId(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function actionToBadgeTone(
  action: string,
): "neutral" | "accent" | "success" | "warning" | "danger" {
  if (action.includes("delete") || action.includes("revoke")) return "danger";
  if (action.includes("approve")) return "success";
  if (action.includes("reject")) return "warning";
  if (action.includes("create")) return "accent";
  return "neutral";
}

/** Date (per the user's date-display preference) plus a fixed UTC time, so
 *  server output is deterministic and every audit row is unambiguous. */
function auditTime(iso: string, pref: DateDisplayPref): { date: string; time: string; exact: string } {
  const d = new Date(iso);
  const time = Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
  const f = formatByPref(iso, pref);
  return { date: f.text, time: time ? `${time} UTC` : "", exact: `${f.absolute} ${time} UTC`.trim() };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})?)\|([0-9a-fA-F-]{8,40})$/;

/** Valid calendar date (YYYY-MM-DD) or undefined. */
function parseDay(v: string | undefined): string | undefined {
  if (!v || !DATE_RE.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? undefined : v;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function parseCursor(v: string | undefined): { at: string; id: string } | undefined {
  const m = v ? CURSOR_RE.exec(v) : null;
  return m ? { at: m[1], id: m[2] } : undefined;
}

function shortId(id: string | null): string {
  if (!id) return "—";
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Build a `/trust`- or `/api/export`-relative href, dropping any param whose value is falsy. */
function hrefWithParams(base: string, params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) usp.set(key, value);
  }
  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base;
}

const CHANNEL_OPTIONS = ["ui", "api", "cli", "mcp", "assistant", "lark"] as const;

export default async function TrustPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  // Reuses the SAME filter-parsing single source of truth as GET /audit and
  // GET /api/export?entity=audit — an unrecognized channel (or any other
  // stray param) is silently dropped rather than passed to a .eq() that
  // would just match zero rows.
  const rawParams = await searchParams;
  const parseInput = new URLSearchParams();
  if (rawParams.target_type) parseInput.set("target_type", rawParams.target_type);
  if (rawParams.target_id) parseInput.set("target_id", rawParams.target_id);
  if (rawParams.action) parseInput.set("action", rawParams.action);
  if (rawParams.channel) parseInput.set("channel", rawParams.channel);
  const filters = parseAuditFilters(parseInput);
  const hasAnyFilter = !!(filters.target_type || filters.target_id || filters.action || filters.channel || rawParams.from || rawParams.to);
  const hasTargetFilter = !!(filters.target_type && filters.target_id);
  const activeFilterCount = (filters.channel ? 1 : 0) + (filters.action ? 1 : 0) + (rawParams.from ? 1 : 0) + (rawParams.to ? 1 : 0);

  const dateDisplayPref = parseAppearancePrefs(
    (await cookies()).get(APPEARANCE_COOKIE_NAME)?.value,
  ).dateDisplay;

  // Date range (UTC days) and keyset cursors are validated; anything
  // malformed is dropped rather than passed to the query.
  const from = parseDay(rawParams.from);
  const to = parseDay(rawParams.to);
  const olderCursor = parseCursor(rawParams.before);
  const newerCursor = olderCursor ? undefined : parseCursor(rawParams.after);
  const goingNewer = !!newerCursor;
  const cursor = olderCursor ?? newerCursor;

  let query = db.from("audit_log").select("*");
  if (filters.target_type) query = query.eq("target_type", filters.target_type);
  if (filters.target_id) query = query.eq("target_id", filters.target_id);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.channel) query = query.eq("channel", filters.channel);
  if (from) query = query.gte("created_at", `${from}T00:00:00Z`);
  if (to) query = query.lt("created_at", nextDay(to));
  if (cursor) {
    // Keyset on (created_at, id): stable even when rows share a timestamp.
    const op = goingNewer ? "gt" : "lt";
    query = query.or(
      `created_at.${op}."${cursor.at}",and(created_at.eq."${cursor.at}",id.${op}."${cursor.id}")`,
    );
  }
  const { data: rows, error } = await query
    .order("created_at", { ascending: goingNewer })
    .order("id", { ascending: goingNewer })
    .limit(PAGE_SIZE + 1);

  let fetched: AuditRow[] = rows ?? [];
  const hasExtra = fetched.length > PAGE_SIZE;
  if (hasExtra) fetched = fetched.slice(0, PAGE_SIZE);
  if (goingNewer) fetched = fetched.reverse();
  const entries: AuditRow[] = fetched;
  // Older exists if we paged forward and got an extra row, or if we arrived
  // from a Newer step (the cursor row itself is older than this page).
  const hasOlder = goingNewer ? entries.length > 0 : hasExtra;
  const hasNewer = goingNewer ? hasExtra : !!olderCursor && entries.length > 0;
  const cursorOf = (r: AuditRow) => `${r.created_at}|${r.id}`;
  const baseParams = {
    target_type: filters.target_type,
    target_id: filters.target_id,
    action: filters.action,
    channel: filters.channel,
    from,
    to,
  };
  const olderHref =
    hasOlder && entries.length > 0
      ? hrefWithParams("/trust", { ...baseParams, before: cursorOf(entries[entries.length - 1]) })
      : null;
  const newerHref =
    hasNewer && entries.length > 0
      ? hrefWithParams("/trust", { ...baseParams, after: cursorOf(entries[0]) })
      : null;

  // The CSV export mirrors whatever filters narrowed the view above, so the
  // downloaded file always matches what's on screen.
  const exportHref = hrefWithParams("/api/export", {
    entity: "audit",
    target_type: filters.target_type,
    target_id: filters.target_id,
    action: filters.action,
    channel: filters.channel,
  });
  // The object-history chip's own Clear drops just target_type/target_id,
  // keeping any action/channel filter the buyer already set.
  const clearTargetHref = hrefWithParams("/trust", {
    action: filters.action,
    channel: filters.channel,
    from,
    to,
  });

  return (
    <div className="min-w-0 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto min-w-0 max-w-4xl space-y-8">
      <PageHeader
        title="Trust Center"
        action={
          <>
            <ExportCsvButton href={exportHref} />
            <Badge tone="accent">Immutable</Badge>
          </>
        }
      />

      {/* Error state */}
      {error && <QueryError what="audit log" message={error.message} className="p-0" />}

      {/* Object-history chip — set by the "History" links on task/risk/issue/
          project detail views (?target_type=&target_id=). */}
      {hasTargetFilter && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
            History for {filters.target_type} <code className="font-mono">{shortId(filters.target_id ?? null)}</code>
          </span>
          <a href={clearTargetHref} className="text-xs text-ink-muted hover:text-ink hover:underline">
            Clear
          </a>
        </div>
      )}

      {/* Filter bar — plain GET form, no client JS. Below md it collapses
          into a single "Filters" button (FilterSheet); the form's own
          Filter/Clear controls still do the work via native navigation, so
          no onApply/onClear callback is needed here. */}
      <FilterSheet activeCount={activeFilterCount}>
        <form
          method="get"
          className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface px-4 py-3 sm:flex-row sm:flex-wrap sm:items-end"
        >
          {filters.target_type && <input type="hidden" name="target_type" value={filters.target_type} />}
          {filters.target_id && <input type="hidden" name="target_id" value={filters.target_id} />}

          <div className="flex flex-col gap-1">
            <label htmlFor="trust-channel" className="text-xs font-medium text-ink-muted uppercase tracking-wide">
              Channel
            </label>
            <select
              id="trust-channel"
              name="channel"
              defaultValue={filters.channel ?? ""}
              className="field h-10 rounded-md border border-border-subtle bg-canvas px-2.5 text-sm text-ink focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent sm:w-auto"
            >
              <option value="">All</option>
              {CHANNEL_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="trust-action" className="text-xs font-medium text-ink-muted uppercase tracking-wide">
              Action
            </label>
            <Input
              id="trust-action"
              name="action"
              defaultValue={filters.action ?? ""}
              placeholder="e.g. task.create"
              list="trust-action-options"
              className="h-11 sm:h-10 sm:w-56"
            />
            <datalist id="trust-action-options">
              {AUDIT_ACTION_GLOSSARY.map((e) => (
                <option key={e.action} value={e.action}>
                  {e.description}
                </option>
              ))}
            </datalist>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="trust-from" className="text-xs font-medium text-ink-muted uppercase tracking-wide">
              From (UTC)
            </label>
            <Input id="trust-from" name="from" type="date" defaultValue={from ?? ""} className="h-11 sm:h-10 sm:w-40" />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="trust-to" className="text-xs font-medium text-ink-muted uppercase tracking-wide">
              To (UTC)
            </label>
            <Input id="trust-to" name="to" type="date" defaultValue={to ?? ""} className="h-11 sm:h-10 sm:w-40" />
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" variant="secondary" size="sm" className="h-11 sm:h-9">
              Filter
            </Button>
            {hasAnyFilter && (
              <a href="/trust" className="text-xs text-ink-muted hover:text-ink hover:underline">
                Clear
              </a>
            )}
          </div>
        </form>
      </FilterSheet>

      {/* Main content row */}
      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        {/* Provenance stream */}
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Provenance stream</CardTitle>
            <span className="text-xs text-ink-muted">
              {entries.length} {entries.length === 1 ? "entry" : "entries"}, newest first
            </span>
          </CardHeader>

          {entries.length === 0 && !error && (
            <CardBody>
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <p className="text-sm text-ink-muted">
                  {hasAnyFilter || cursor
                    ? "No audit events match these filters."
                    : "No audit events recorded yet."}
                </p>
                {(hasAnyFilter || cursor) && (
                  <a href="/trust" className="text-xs text-accent hover:underline">
                    Clear filters
                  </a>
                )}
              </div>
            </CardBody>
          )}

          {entries.length > 0 && (
            <Table bare>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Action</TH>
                  <TH>Actor</TH>
                  <TH className="hidden md:table-cell">Target</TH>
                </TR>
              </THead>
              <tbody>
                {entries.map((entry) => {
                  const t = auditTime(entry.created_at, dateDisplayPref);
                  return (
                    <TR key={entry.id} className="align-top transition-colors duration-100 hover:bg-sunken">
                      <TD className="whitespace-nowrap">
                        <time dateTime={entry.created_at} title={t.exact} className="block text-xs font-medium text-ink-secondary">
                          {t.date}
                        </time>
                        <span className="block font-mono text-2xs text-ink-muted">{t.time}</span>
                      </TD>
                      <TD>
                        <Badge tone={actionToBadgeTone(entry.action)} className="font-mono text-xs">
                          {entry.action}
                        </Badge>
                        {entry.request_id && (
                          <p className="mt-1 font-mono text-2xs text-ink-muted">
                            req: {shortRequestId(entry.request_id)}
                          </p>
                        )}
                        <p className="mt-1 text-2xs text-ink-muted md:hidden">
                          <span className="capitalize">{entry.target_type}</span>{" "}
                          <code className="rounded bg-sunken px-1 py-0.5 font-mono text-ink-secondary">
                            {shortId(entry.target_id)}
                          </code>
                        </p>
                      </TD>
                      <TD>
                        <div className="flex flex-wrap items-center gap-1.5 text-sm">
                          <span className="font-medium text-ink">{entry.actor_label}</span>
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-1.5 py-0.5 text-xs",
                              entry.actor_type === "token"
                                ? "bg-warning/15 text-warning-ink"
                                : "bg-sunken text-ink-secondary",
                            )}
                          >
                            {entry.actor_type === "token" ? "token" : "user"}
                          </span>
                          {entry.channel && (
                            <span
                              title={`declared client: ${entry.channel} (caller-asserted, not an authorization input)`}
                              className="inline-flex items-center rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary"
                            >
                              {entry.channel}
                            </span>
                          )}
                        </div>
                      </TD>
                      <TD className="hidden text-xs text-ink-muted md:table-cell">
                        <span className="capitalize">{entry.target_type}</span>
                        <code className="ml-1.5 rounded bg-sunken px-1 py-0.5 font-mono text-ink-secondary">
                          {shortId(entry.target_id)}
                        </code>
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          )}

          {(olderHref || newerHref) && (
            <nav
              aria-label="Audit stream pages"
              className="flex items-center justify-between border-t border-border-subtle px-5 py-3 text-sm"
            >
              {newerHref ? (
                <a href={newerHref} rel="prev" className="text-accent hover:underline">
                  &larr; Newer
                </a>
              ) : (
                <span />
              )}
              {olderHref ? (
                <a href={olderHref} rel="next" className="text-accent hover:underline">
                  Older &rarr;
                </a>
              ) : (
                <span />
              )}
            </nav>
          )}
        </Card>

        {/* Sidebar: Legend */}
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Action glossary</CardTitle>
            </CardHeader>
            <CardBody className="max-h-96 overflow-y-auto p-0">
              <ul className="divide-y divide-border-subtle">
                {AUDIT_ACTION_GLOSSARY.map(({ action, description }) => (
                  <li key={action} className="px-4 py-3 space-y-0.5">
                    <code className="block text-xs font-mono text-ink">
                      {action}
                    </code>
                    <p className="text-xs text-ink-muted">{description}</p>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          {/* Actor type legend */}
          <Card>
            <CardHeader>
              <CardTitle>Actor types</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex rounded-full bg-sunken px-1.5 py-0.5 text-xs text-ink-secondary shrink-0">
                  user
                </span>
                <p className="text-xs text-ink-muted">
                  A human signed in via the console or OAuth session.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex rounded-full bg-warning/15 px-1.5 py-0.5 text-xs text-warning-ink shrink-0">
                  token
                </span>
                <p className="text-xs text-ink-muted">
                  A scoped PAT (Personal Access Token) used by an automated agent or the CLI.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary shrink-0">
                  cli
                </span>
                <p className="text-xs text-ink-muted">
                  declared client — which surface (ui/api/cli/mcp/assistant) said it made the
                  call. Token identity is authoritative; the channel is caller-asserted.
                </p>
              </div>
            </CardBody>
          </Card>

          {/* What this proves — the four claims a governance buyer will ask about. */}
          <Card>
            <CardHeader>
              <CardTitle>What this proves</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <div>
                <p className="text-xs font-medium text-ink">Retention</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Rows are kept for the life of the workspace and are never updated or deleted;
                  two database triggers reject both, for every role including the service key.
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-ink">Provenance</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Each row names the actor, the declared client, and a request id echoed on the
                  API response.
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-ink">Fail-closed honesty</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Deletion and invite commits write their audit rows in the same database
                  transaction as the change. Other writes persist first and return an error if the
                  audit row cannot be written.
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-ink">Export</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Export the current view as CSV at any time; the export itself is audited.
                </p>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
      </div>
    </div>
  );
}
