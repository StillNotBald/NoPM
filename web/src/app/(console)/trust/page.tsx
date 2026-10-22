import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { AuditPackPanel } from "@/components/export/audit-pack-panel";
import { ChainBadge, type ChainCheck } from "@/components/audit/chain-badge";
import { AnchorStatus } from "@/components/trust/anchor-status";
import { getAnchorSink } from "@/lib/audit/anchor/get-sink";
import { receiptToView, NOT_ANCHORED_VIEW, type AnchorView } from "@/lib/audit/anchor/view";
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
  channel?: "ui" | "api" | "cli" | "mcp" | "assistant" | "lark" | string | null;
  request_id?: string | null;
  /** The human behind the actor (migration 0071); null for system actors and RPC-written rows. */
  principal_id?: string | null;
}

function shortRequestId(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

// Blue means "an action you can take" or a live signal; an audit category is
// neither, so creation reads as neutral (only the outcomes carry a status hue).
function actionToBadgeTone(action: string): "neutral" | "success" | "warning" | "danger" {
  if (action.includes("delete") || action.includes("revoke")) return "danger";
  if (action.includes("approve")) return "success";
  if (action.includes("reject")) return "warning";
  return "neutral";
}

/** Who did it: the name, whether a person or a token, and the declared client. */
function AuditActor({ entry }: { entry: AuditRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <span className="font-medium text-ink">{entry.actor_label}</span>
      <span
        className={cn(
          "inline-flex items-center rounded-full px-1.5 py-0.5 text-xs",
          entry.actor_type === "token" ? "bg-warning/15 text-warning-ink" : "bg-well text-ink-secondary",
        )}
      >
        {entry.actor_label?.startsWith("system:") ? "system" : entry.actor_type === "token" ? "token" : "user"}
      </span>
      {entry.channel && (
        <span
          title={`declared client: ${entry.channel} (caller-asserted, not an authorization input)`}
          className="inline-flex items-center rounded bg-well px-1.5 py-0.5 font-mono text-2xs text-ink-secondary"
        >
          {entry.channel}
        </span>
      )}
    </div>
  );
}

/** Date (per the user's date-display preference) plus a fixed UTC time, so
 *  server output is deterministic and every audit row is unambiguous. */
function auditTime(iso: string, pref: DateDisplayPref): { date: string; time: string; exact: string } {
  const d = new Date(iso);
  const time = Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
  // The date is the UTC date too (D1): a UTC-labelled time next to a local-zone date misreads late evenings.
  const f = formatByPref(Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)}T12:00:00.000Z`, pref);
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

const CHANNEL_OPTIONS = ["ui", "api", "cli", "mcp", "assistant", "lark", "github"] as const;

/** Unpadded text links ("Clear", pager): a 44px hit area on phones, text-sized from sm. */
const LINK_TARGET = "focus-ring inline-flex min-h-[44px] items-center rounded-sm text-xs sm:min-h-0";

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
  // Audit pack button: admin or manager only (the export route enforces the same rule).
  const { data: viewerProfile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const canAuditPack = viewerProfile?.role === "admin" || viewerProfile?.role === "manager";

  // Audit hash chain (R-154): the newest recorded check, shown with a "Verify now" button.
  // Only admins and managers see it; GET /api/audit/verify enforces the same rule.
  let lastChainCheck: ChainCheck | null = null;
  let lastCheckAt: string | null = null;
  // External anchor (R-170): first paint from the display receipt; "not anchored" whenever the variable is unset.
  let anchorView: AnchorView = { ...NOT_ANCHORED_VIEW };
  if (canAuditPack) {
    if (getAnchorSink().kind !== "none") {
      const { data: receipt } = await db
        .from("audit_anchor_receipts")
        .select("status, chain_seq, anchored_at, row_count, streak_started_at, reset_at")
        .maybeSingle();
      anchorView = receiptToView(
        receipt
          ? {
              status: receipt.status as "anchored" | "failed" | "mismatch",
              chain_seq: receipt.chain_seq == null ? null : Number(receipt.chain_seq),
              anchored_at: (receipt.anchored_at as string | null) ?? null,
              row_count: receipt.row_count == null ? null : Number(receipt.row_count),
              streak_started_at: (receipt.streak_started_at as string | null) ?? null,
              reset_at: (receipt.reset_at as string | null) ?? null,
            }
          : null,
        true,
      );
    }
    const { data: lastCheck } = await db
      .from("audit_log")
      .select("after, created_at")
      .eq("action", "audit.verified")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const a = (lastCheck?.after ?? null) as { ok?: boolean; chain_ok?: boolean; checked?: number; first_bad_id?: string | null; first_bad_at?: string | null } | null;
    lastCheckAt = (lastCheck?.created_at as string | undefined) ?? null;
    if (lastCheck && a && typeof a.ok === "boolean") {
      lastChainCheck = {
        // The badge says whether the CHAIN verified; an anchor mismatch has its own red card below it.
        ok: typeof a.chain_ok === "boolean" ? a.chain_ok : a.ok,
        checked: Number(a.checked ?? 0),
        at: lastCheck.created_at as string,
        firstBadId: a.first_bad_id ?? null,
        firstBadAt: a.first_bad_at ?? null,
      };
    }
  }

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
    from,
    to,
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
    <PageContainer width="narrow" className="space-y-8">
      <PageHeader
        title="Trust Center"
        action={
          <>
            <ExportCsvButton href={exportHref} />
            <Badge tone="neutral">Immutable</Badge>
          </>
        }
      />

      {canAuditPack && <ChainBadge initial={lastChainCheck} />}

      {canAuditPack && <AnchorStatus anchor={anchorView} asOf={lastCheckAt} />}

      {canAuditPack && <AuditPackPanel />}

      {/* Error state */}
      {error && <QueryError what="audit log" message={error.message} className="p-0" />}

      {/* Object-history chip — set by the "History" links on task/risk/issue/
          project detail views (?target_type=&target_id=). */}
      {hasTargetFilter && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-well px-3 py-1 text-xs font-medium text-ink">
            History for {filters.target_type} <code className="font-mono">{shortId(filters.target_id ?? null)}</code>
          </span>
          <a href={clearTargetHref} className={LINK_TARGET + " text-ink-secondary hover:text-ink hover:underline"}>
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
              className="field h-11 rounded-md border border-border-subtle bg-canvas px-2.5 text-base text-ink focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent sm:h-10 sm:w-auto sm:text-sm"
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
              <a href="/trust" className={LINK_TARGET + " text-ink-secondary hover:text-ink hover:underline"}>
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
                <p className="max-w-sm text-sm text-ink-muted">
                  {filters.channel === "lark"
                    ? "Nothing from Lark yet. Decisions made on a Lark card show here with channel “lark”."
                    : hasAnyFilter || cursor
                      ? "No audit events match these filters."
                      : "No audit events recorded yet."}
                </p>
                {(hasAnyFilter || cursor) && (
                  <a href="/trust" className={LINK_TARGET + " text-accent hover:underline"}>
                    Clear filters
                  </a>
                )}
              </div>
            </CardBody>
          )}

          {entries.length > 0 && (
            <ul className="divide-y divide-border-subtle md:hidden" aria-label="Provenance stream">
              {entries.map((entry) => {
                const t = auditTime(entry.created_at, dateDisplayPref);
                return (
                  <li key={entry.id} className="space-y-2 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <Badge tone={actionToBadgeTone(entry.action)} className="font-mono text-xs">
                        {entry.action}
                      </Badge>
                      <time dateTime={entry.created_at} title={t.exact} className="text-xs text-ink-secondary">
                        {t.date} <span className="font-mono text-2xs text-ink-muted">{t.time}</span>
                      </time>
                    </div>
                    <AuditActor entry={entry} />
                    <p className="text-2xs text-ink-muted">
                      <span className="capitalize">{entry.target_type}</span>{" "}
                      <code className="rounded bg-well px-1 py-0.5 font-mono text-ink-secondary">
                        {shortId(entry.target_id)}
                      </code>
                      {entry.request_id && (
                        <>
                          {" · "}
                          <span className="font-mono">req: {shortRequestId(entry.request_id)}</span>
                        </>
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}

          {entries.length > 0 && (
            <div className="hidden md:block">
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
                    <TR key={entry.id} className="align-top transition-colors duration-100 hover:bg-well">
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
                          <code className="rounded bg-well px-1 py-0.5 font-mono text-ink-secondary">
                            {shortId(entry.target_id)}
                          </code>
                        </p>
                      </TD>
                      <TD>
                        <AuditActor entry={entry} />
                      </TD>
                      <TD className="hidden text-xs text-ink-muted md:table-cell">
                        <span className="capitalize">{entry.target_type}</span>
                        <code className="ml-1.5 rounded bg-well px-1 py-0.5 font-mono text-ink-secondary">
                          {shortId(entry.target_id)}
                        </code>
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
            </div>
          )}

          {(olderHref || newerHref) && (
            <nav
              aria-label="Audit stream pages"
              className="flex items-center justify-between border-t border-border-subtle px-5 py-3 text-sm"
            >
              {newerHref ? (
                <a href={newerHref} rel="prev" className="focus-ring inline-flex min-h-[44px] items-center rounded-sm text-accent hover:underline sm:min-h-0">
                  &larr; Newer
                </a>
              ) : (
                <span />
              )}
              {olderHref ? (
                <a href={olderHref} rel="next" className="focus-ring inline-flex min-h-[44px] items-center rounded-sm text-accent hover:underline sm:min-h-0">
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
            <CardBody
              className="max-h-96 overflow-y-auto p-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              role="region"
              aria-label="Action glossary entries"
              tabIndex={0}
            >
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
                <span className="mt-0.5 inline-flex rounded-full bg-well px-1.5 py-0.5 text-xs text-ink-secondary shrink-0">
                  user
                </span>
                <p className="text-xs text-ink-muted">
                  A person.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex rounded-full bg-warning/15 px-1.5 py-0.5 text-xs text-warning-ink shrink-0">
                  token
                </span>
                <p className="text-xs text-ink-muted">
                  A scoped PAT (token) used by an agent or the CLI.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex rounded bg-well px-1.5 py-0.5 font-mono text-2xs text-ink-secondary shrink-0">
                  cli
                </span>
                <p className="text-xs text-ink-muted">
                  declared client (ui, api, cli, mcp, assistant, lark). The token
                  identity is authoritative; the channel is caller-asserted.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex rounded bg-well px-1.5 py-0.5 font-mono text-2xs text-ink-secondary shrink-0">
                  lark
                </span>
                <p className="text-xs text-ink-muted">
                  a decision made on a Lark card. Recorded as the person who linked that
                  Lark account (a user, channel lark).
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
                  Rows are kept for the life of the workspace. Database triggers reject any update or delete, for every role including the service key.
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-ink">Provenance</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Each row names the actor, the declared client and a request id.
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-ink">Fail-closed honesty</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Deletion and invite commits write the audit row in the same transaction. Other writes persist first, then return an error if the audit row fails.
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-ink">Export</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Export the current view as CSV. The export is audited.
                </p>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
