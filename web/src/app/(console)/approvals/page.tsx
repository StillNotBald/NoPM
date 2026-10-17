import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { ApprovalActions } from "@/components/approvals/actions";
import { FourEyesNote, type DecideState } from "@/components/governance/four-eyes-note";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { QueueCallout } from "@/components/ui/queue-callout";
import { QueryError } from "@/components/ui/query-error";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, THead, TH, TR, TD } from "@/components/ui/data-table";
import { UrlFilter } from "@/app/(console)/review/_url-filter";
import { oldestAgeDays } from "@/lib/format/dates";
import { describeDeletionTarget, describeChildCounts, targetPhrase, type DeletionTarget } from "@/lib/review/deletion-target";
import { ChildCountsNote } from "@/components/review/child-counts-note";
import { judgeDecision } from "@/lib/review/four-eyes";
import { DECIDED_PAGE_SIZE, PENDING_CAP, pageWindow, parsePage } from "./_paging";

export const metadata = { title: "Approvals" };

interface DeletionRequest {
  id: string;
  target_type: string;
  target_id: string;
  requested_by_type: string;
  requested_by_id: string;
  requested_principal_id: string | null;
  requested_by_label: string;
  approved_by_label: string | null;
  reason: string | null;
  before: unknown;
  created_at: string;
  decided_at: string | null;
  status: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function decidedHref(page: number): string {
  return page > 1 ? `/approvals?status=decided&page=${page}` : "/approvals?status=decided";
}

function shortId(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function statusTone(s: string) {
  if (s === "approved" || s === "committed") return "success" as const;
  if (s === "rejected") return "danger" as const;
  if (s === "pending") return "warning" as const;
  return "neutral" as const;
}

/** The record the decision is about: its name (from the request's `before` snapshot), type and project. */
function TargetSummary({
  req,
  target,
  projectName,
}: {
  req: DeletionRequest;
  target: DeletionTarget;
  projectName: string | null;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="danger" size="sm">deletion request</Badge>
        <span className="text-xs capitalize text-ink-secondary">{target.type}</span>
      </div>
      <p className="mt-1 break-words text-sm font-medium text-ink">
        {target.name ?? <span className="text-ink-muted">Name not recorded</span>}
      </p>
      {projectName && target.type !== "project" && (
        <p className="text-xs text-ink-muted">in {projectName}</p>
      )}
      {req.reason && (
        <p className="mt-1 text-xs text-ink-secondary">
          <span className="text-ink-muted">Reason:</span> <span className="italic">{req.reason}</span>
        </p>
      )}
      {req.target_type === "project" && req.status === "pending" && (
        <ChildCountsNote lines={describeChildCounts(req.before)} />
      )}
      {!target.name && (
        <code className="mt-1 inline-block rounded bg-sunken px-1.5 py-0.5 font-mono text-2xs text-ink-secondary">
          {shortId(req.target_id)}
        </code>
      )}
    </>
  );
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const { status: statusParam, page: pageParam } = await searchParams;
  const view = statusParam === "decided" ? "decided" : "pending";

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  // Pending and decided are queried separately: filtering a newest-first,
  // capped list in JS dropped the oldest pending requests (the ones most
  // overdue) once enough newer decided ones existed. Pending is the work queue
  // (status filter in SQL, no paging); Decided is paged and counted exactly.
  const [pendingRes, decidedCountRes, { data: viewerProfile }, { data: projects }] = await Promise.all([
    db
      .from("deletion_requests")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(PENDING_CAP),
    db.from("deletion_requests").select("id", { count: "exact", head: true }).neq("status", "pending"),
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("projects").select("id, name, is_locked"),
  ]);

  if (pendingRes.error) return <QueryError what="approval requests" message={pendingRes.error.message} />;
  if (decidedCountRes.error) return <QueryError what="approval requests" message={decidedCountRes.error.message} />;

  const decidedTotal = decidedCountRes.count ?? 0;
  const win = pageWindow(parsePage(pageParam), decidedTotal);
  let decided: DeletionRequest[] = [];
  if (view === "decided" && decidedTotal > 0) {
    const decidedRes = await db
      .from("deletion_requests")
      .select("*")
      .neq("status", "pending")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(win.from, win.to);
    if (decidedRes.error) return <QueryError what="approval requests" message={decidedRes.error.message} />;
    decided = (decidedRes.data ?? []) as DeletionRequest[];
  }

  const viewer = { id: user.id, role: (viewerProfile?.role as string | null | undefined) ?? null };
  const projectName = new Map<string, string>((projects ?? []).map((p) => [p.id as string, p.name as string]));

  const lockedProjects = new Set<string>(
    (projects ?? []).filter((p) => (p as { is_locked?: boolean }).is_locked).map((p) => p.id as string),
  );
  const pending = (pendingRes.data ?? []) as DeletionRequest[];
  const pendingCapped = pending.length >= PENDING_CAP;
  const rows = view === "pending" ? pending : decided;

  // Four-eyes, decided the way the API decides: by person (a token counts as
  // the person who created it), not by actor id. Only the rows the viewer can
  // actually decide are "waiting on me".
  const stateOf = new Map<string, DecideState>(
    pending.map((r) => [
      r.id,
      judgeDecision({
        viewer,
        kind: r.target_type === "project" ? "project_deletion" : "task_deletion",
        row: r,
        projectLocked: (() => {
          const pid = describeDeletionTarget(r).projectId;
          return !!pid && lockedProjects.has(pid);
        })(),
      }),
    ]),
  );
  const mine = pending.filter((r) => stateOf.get(r.id)?.canDecide);
  const oldestDays = oldestAgeDays(mine.map((r) => r.created_at));

  const entries = rows.map((req) => {
    const target = describeDeletionTarget(req);
    return {
      req,
      target,
      project: target.projectId ? (projectName.get(target.projectId) ?? null) : null,
      decide: stateOf.get(req.id),
    };
  });

  return (
    <PageContainer width="narrow" className="space-y-6">
      <PageHeader title="Approvals" />

      <QueueCallout count={mine.length} noun="deletion request" className="mb-3">
        awaiting your decision · oldest waiting {oldestDays === 0 ? "today" : `${oldestDays} day${oldestDays === 1 ? "" : "s"}`}
      </QueueCallout>

      <FourEyesNote variant="quiet" />

      <UrlFilter
        label="Approval status"
        value={view}
        defaultValue="pending"
        options={[
          { value: "pending", label: "Pending", count: pending.length, attention: mine.length > 0 },
          { value: "decided", label: "Decided", count: decidedTotal },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState
          purpose={
            view === "pending"
              ? "All clear. No deletion requests are pending approval right now."
              : "No deletion requests have been decided yet."
          }
        />
      ) : (
        <>
          {/* ≥md: table */}
          <div className="hidden md:block">
            <Table>
              <THead>
                <TR>
                  <TH>Request</TH>
                  <TH>Requested by</TH>
                  <TH>{view === "pending" ? "Raised" : "Decided"}</TH>
                  <TH align="right">{view === "pending" ? "Action" : "Outcome"}</TH>
                </TR>
              </THead>
              <tbody>
                {entries.map(({ req, target, project, decide }) => (
                  <TR key={req.id}>
                    <TD className="align-top">
                      <TargetSummary req={req} target={target} projectName={project} />
                    </TD>
                    <TD className="align-top text-ink-secondary">{req.requested_by_label}</TD>
                    <TD className="whitespace-nowrap align-top text-xs text-ink-muted">
                      {formatDate(view === "pending" ? req.created_at : (req.decided_at ?? req.created_at))}
                    </TD>
                    <TD align="right" className="align-top">
                      {view === "pending" && decide ? (
                        <ApprovalActions requestId={req.id} decide={decide} subject={targetPhrase(target)} />
                      ) : (
                        <div className="flex flex-col items-end gap-1">
                          <Badge tone={statusTone(req.status)} size="sm">{req.status}</Badge>
                          {req.approved_by_label && (
                            <span className="text-xs text-ink-muted">by {req.approved_by_label}</span>
                          )}
                        </div>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>

          {/* <md: one card per request, with the decision reachable underneath */}
          <ul className="space-y-3 md:hidden">
            {entries.map(({ req, target, project, decide }) => (
              <li key={req.id} className="space-y-3 rounded-lg border border-border-subtle bg-surface p-4">
                <div>
                  <TargetSummary req={req} target={target} projectName={project} />
                </div>
                <p className="text-xs text-ink-muted">
                  Requested by <span className="text-ink-secondary">{req.requested_by_label}</span> ·{" "}
                  {view === "pending" ? "raised" : "decided"}{" "}
                  {formatDate(view === "pending" ? req.created_at : (req.decided_at ?? req.created_at))}
                </p>
                {view === "pending" && decide ? (
                  <ApprovalActions requestId={req.id} decide={decide} subject={targetPhrase(target)} />
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={statusTone(req.status)} size="sm">{req.status}</Badge>
                    {req.approved_by_label && (
                      <span className="text-xs text-ink-muted">by {req.approved_by_label}</span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {view === "pending" && pendingCapped && (
        <p className="text-xs text-ink-muted">
          Showing the newest {PENDING_CAP} pending requests; older ones are not listed here.
        </p>
      )}

      {view === "decided" && win.lastPage > 1 && (
        <nav
          aria-label="Decided requests pages"
          className="flex items-center justify-between text-sm"
        >
          {win.page > 1 ? (
            <a
              href={decidedHref(win.page - 1)}
              rel="prev"
              className="focus-ring inline-flex min-h-[44px] items-center rounded-sm text-accent hover:underline sm:min-h-0"
            >
              &larr; Newer
            </a>
          ) : (
            <span />
          )}
          <span className="text-xs text-ink-muted">
            Page {win.page} of {win.lastPage} · {DECIDED_PAGE_SIZE} per page
          </span>
          {win.page < win.lastPage ? (
            <a
              href={decidedHref(win.page + 1)}
              rel="next"
              className="focus-ring inline-flex min-h-[44px] items-center rounded-sm text-accent hover:underline sm:min-h-0"
            >
              Older &rarr;
            </a>
          ) : (
            <span />
          )}
        </nav>
      )}
    </PageContainer>
  );
}
