import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { ExportCsvButton } from "@/components/export-csv-button";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FilterSheet } from "@/components/ui/filter-sheet";
import { cn } from "@/lib/cn";
import { parseAuditFilters } from "@/app/api/audit/_query";

export const metadata = { title: "Trust Center — NoPM" };

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

const COMMON_ACTIONS: { action: string; description: string }[] = [
  { action: "task.create", description: "A new task was created" },
  { action: "task.update", description: "A task field was mutated" },
  { action: "task.delete", description: "Hard delete committed after approval" },
  { action: "deletion_request.create", description: "Deletion request raised" },
  { action: "deletion_request.approve", description: "Second reviewer approved request" },
  { action: "deletion_request.reject", description: "Second reviewer rejected request" },
  { action: "deletion_request.withdrawn", description: "Requester withdrew their own request" },
  { action: "project.create", description: "A project was created" },
  { action: "project.update", description: "Project metadata was updated" },
  { action: "risk.create", description: "A risk was logged" },
  { action: "token.create", description: "A PAT was issued" },
  { action: "token.revoke", description: "A PAT was revoked" },
];

function actionToBadgeTone(
  action: string,
): "neutral" | "accent" | "success" | "warning" | "danger" {
  if (action.includes("delete") || action.includes("revoke")) return "danger";
  if (action.includes("approve")) return "success";
  if (action.includes("reject")) return "warning";
  if (action.includes("create")) return "accent";
  return "neutral";
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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

const CHANNEL_OPTIONS = ["ui", "api", "cli", "mcp", "assistant"] as const;

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
  const hasAnyFilter = !!(filters.target_type || filters.target_id || filters.action || filters.channel);
  const hasTargetFilter = !!(filters.target_type && filters.target_id);
  const activeFilterCount = (filters.channel ? 1 : 0) + (filters.action ? 1 : 0);

  let query = db.from("audit_log").select("*");
  if (filters.target_type) query = query.eq("target_type", filters.target_type);
  if (filters.target_id) query = query.eq("target_id", filters.target_id);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.channel) query = query.eq("channel", filters.channel);
  const { data: rows, error } = await query
    .order("created_at", { ascending: false })
    .limit(50);

  const entries: AuditRow[] = rows ?? [];

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
  });

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
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
      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/15 px-4 py-3 text-sm text-danger">
          Failed to load audit log: {error.message}
        </div>
      )}

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
              className="field h-10 rounded-md border border-border-subtle bg-canvas px-2.5 text-sm text-ink focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30 sm:w-auto"
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
              className="h-11 sm:h-10 sm:w-56"
            />
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
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_260px]">
        {/* Timeline */}
        <Card>
          <CardHeader>
            <CardTitle>Provenance timeline</CardTitle>
            <span className="text-xs text-ink-muted">
              {entries.length === 50 ? "Showing newest 50 entries" : `${entries.length} entries`}
            </span>
          </CardHeader>

          {entries.length === 0 && !error && (
            <CardBody>
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <p className="text-sm text-ink-muted">No audit events recorded yet.</p>
              </div>
            </CardBody>
          )}

          {entries.length > 0 && (
            <div className="divide-y divide-border-subtle">
              {entries.map((entry, idx) => (
                <div key={entry.id} className="relative flex gap-4 px-5 py-4 hover:bg-sunken transition-colors duration-100">
                  {/* Vertical connector line */}
                  <div className="relative flex flex-col items-center">
                    {/* Coral dot */}
                    <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-accent ring-2 ring-accent/20" />
                    {/* Connector */}
                    {idx < entries.length - 1 && (
                      <span className="mt-1 w-px flex-1 bg-border-subtle" aria-hidden />
                    )}
                  </div>

                  {/* Entry body — a compact card at every width: action +
                      time share a row (time wraps under the badge on
                      narrow screens instead of hanging as an orphan column
                      to the right), then actor, target, request id. */}
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <Badge
                        tone={actionToBadgeTone(entry.action)}
                        className="font-mono text-xs"
                      >
                        {entry.action}
                      </Badge>
                      <div className="text-left sm:text-right">
                        <time
                          dateTime={entry.created_at}
                          title={absoluteTime(entry.created_at)}
                          className="block text-xs font-medium text-ink-secondary"
                        >
                          {relativeTime(entry.created_at)}
                        </time>
                        <span className="block text-2xs text-ink-muted">
                          {absoluteTime(entry.created_at)}
                        </span>
                      </div>
                    </div>

                    {/* Actor */}
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="text-ink-muted">by</span>
                      <span className="font-medium text-ink">{entry.actor_label}</span>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-1.5 py-0.5 text-xs",
                          entry.actor_type === "token"
                            ? "bg-warning/15 text-warning"
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

                    {/* Target */}
                    <p className="text-xs text-ink-muted">
                      <span className="capitalize">{entry.target_type}</span>
                      <code className="ml-1.5 rounded bg-sunken px-1 py-0.5 font-mono text-ink-secondary">
                        {shortId(entry.target_id)}
                      </code>
                    </p>

                    {/* Request id — provenance, always present but easy to
                        skim past at text-2xs. */}
                    {entry.request_id && (
                      <p className="font-mono text-2xs text-ink-muted">
                        req: {shortRequestId(entry.request_id)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Sidebar: Legend */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Common actions</CardTitle>
            </CardHeader>
            <CardBody className="p-0">
              <ul className="divide-y divide-border-subtle">
                {COMMON_ACTIONS.map(({ action, description }) => (
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
                <span className="mt-0.5 inline-flex rounded-full bg-warning/15 px-1.5 py-0.5 text-xs text-warning shrink-0">
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
