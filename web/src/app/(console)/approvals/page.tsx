import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { ApprovalActions } from "@/components/approvals/actions";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { QueueCallout } from "@/components/ui/queue-callout";
import { QueryError } from "@/components/ui/query-error";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, THead, TH, TR, TD } from "@/components/ui/data-table";
import { UrlFilter } from "@/app/(console)/review/_url-filter";
import { oldestAgeDays } from "@/lib/format/dates";

export const metadata = { title: "Approvals" };

interface DeletionRequest {
  id: string;
  target_type: string;
  target_id: string;
  requested_by_type: string;
  requested_by_id: string;
  requested_by_label: string;
  approved_by_label: string | null;
  reason: string | null;
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

function shortId(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function statusTone(s: string) {
  if (s === "approved" || s === "committed") return "success" as const;
  if (s === "rejected") return "danger" as const;
  if (s === "pending") return "warning" as const;
  return "neutral" as const;
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: statusParam } = await searchParams;
  const view = statusParam === "decided" ? "decided" : "pending";

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const { data: requests, error } = await db
    .from("deletion_requests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) return <QueryError what="approval requests" message={error.message} />;

  const all = (requests ?? []) as DeletionRequest[];
  const pending = all.filter((r) => r.status === "pending");
  const decided = all.filter((r) => r.status !== "pending");
  const rows = view === "pending" ? pending : decided;

  const isOwn = (r: DeletionRequest) => r.requested_by_type === "user" && r.requested_by_id === user.id;
  // Four-eyes: the requester can't decide their own request, so it isn't "waiting on me".
  const mine = pending.filter((r) => !isOwn(r));
  const oldestDays = oldestAgeDays(mine.map((r) => r.created_at));

  return (
    <PageContainer width="narrow" className="space-y-6">
      <PageHeader title="Approvals" />

      <QueueCallout count={mine.length} noun="deletion request" className="mb-0">
        Oldest waiting {oldestDays === 0 ? "today" : `${oldestDays} day${oldestDays === 1 ? "" : "s"}`}
      </QueueCallout>

      <p className="-mt-3 text-sm text-ink-muted">
        <span className="font-semibold text-ink-secondary">Four-eyes control:</span> the approver must be a
        different person from the requester. Self-approval is blocked at the API layer and returns{" "}
        <code className="rounded bg-sunken px-1 py-0.5 font-mono text-xs">403</code>.
      </p>

      <UrlFilter
        label="Approval status"
        value={view}
        defaultValue="pending"
        options={[
          { value: "pending", label: "Pending", count: pending.length, attention: mine.length > 0 },
          { value: "decided", label: "Decided", count: decided.length },
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
            {rows.map((req) => (
              <TR key={req.id}>
                <TD className="align-top">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="danger" size="sm">deletion request</Badge>
                    <span className="font-medium capitalize">{req.target_type}</span>
                    <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink-secondary">
                      {shortId(req.target_id)}
                    </code>
                  </div>
                  {req.reason && (
                    <p className="mt-1 text-xs text-ink-secondary">
                      <span className="text-ink-muted">Reason:</span> <span className="italic">{req.reason}</span>
                    </p>
                  )}
                </TD>
                <TD className="align-top text-ink-secondary">{req.requested_by_label}</TD>
                <TD className="whitespace-nowrap align-top text-xs text-ink-muted">
                  {formatDate(view === "pending" ? req.created_at : (req.decided_at ?? req.created_at))}
                </TD>
                <TD align="right" className="align-top">
                  {view === "pending" ? (
                    <ApprovalActions requestId={req.id} isOwn={isOwn(req)} />
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
      )}
    </PageContainer>
  );
}
