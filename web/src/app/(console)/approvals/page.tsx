import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ApprovalActions } from "@/components/approvals/actions";
import { cn } from "@/lib/cn";

export const metadata = { title: "Approvals — NoPM" };

interface DeletionRequest {
  id: string;
  target_type: string;
  target_id: string;
  requested_by_label: string;
  reason: string | null;
  created_at: string;
  status: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortId(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export default async function ApprovalsPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const { data: requests, error } = await db
    .from("deletion_requests")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  const pending: DeletionRequest[] = requests ?? [];

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold text-ink">Approvals</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Pending deletion requests awaiting a second reviewer.
        </p>
      </div>

      {/* Four-eyes banner */}
      <div className="flex gap-3 rounded-lg border border-border-subtle bg-warning/10 px-4 py-3">
        <span className="mt-0.5 text-warning shrink-0" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M8 1.5a6.5 6.5 0 1 0 0 13A6.5 6.5 0 0 0 8 1.5ZM7.25 4.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0v-3.5Zm.75 6.5a.875.875 0 1 1 0-1.75.875.875 0 0 1 0 1.75Z"
              fill="currentColor"
            />
          </svg>
        </span>
        <p className="text-sm text-warning">
          <span className="font-semibold">Four-eyes control:</span> the approver must be a different
          person from the requester. Self-approval is blocked at the API layer and will return{" "}
          <code className="rounded px-1 py-0.5 bg-warning/15 text-xs font-mono">403</code>.
        </p>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/15 px-4 py-3 text-sm text-danger">
          Failed to load requests: {error.message}
        </div>
      )}

      {/* Empty state */}
      {!error && pending.length === 0 && (
        <Card>
          <CardBody>
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span
                className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success"
                aria-hidden
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path
                    d="M20 6 9 17l-5-5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <div>
                <p className="font-medium text-ink">All clear</p>
                <p className="mt-1 text-sm text-ink-muted">
                  No deletion requests are pending approval right now.
                </p>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Request list */}
      {pending.length > 0 && (
        <div className="space-y-3">
          {pending.map((req) => (
            <Card key={req.id}>
              <CardBody>
                <div className="flex items-start justify-between gap-6">
                  {/* Left: request detail */}
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="danger">deletion request</Badge>
                      <span className="text-sm font-medium text-ink capitalize">
                        {req.target_type}
                      </span>
                      <code className="rounded bg-sunken px-1.5 py-0.5 text-xs font-mono text-ink-secondary">
                        {shortId(req.target_id)}
                      </code>
                    </div>

                    <div className="space-y-1">
                      <p className="text-sm text-ink-secondary">
                        <span className="text-ink-muted">Requested by</span>{" "}
                        <span className="font-medium text-ink">{req.requested_by_label}</span>
                      </p>
                      {req.reason && (
                        <p className="text-sm text-ink-secondary">
                          <span className="text-ink-muted">Reason:</span>{" "}
                          <span className="italic">{req.reason}</span>
                        </p>
                      )}
                    </div>

                    <p className="text-xs text-ink-muted">{formatDate(req.created_at)}</p>
                  </div>

                  {/* Right: actions */}
                  <div className="shrink-0">
                    <ApprovalActions requestId={req.id} />
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* Count footer */}
      {pending.length > 0 && (
        <p className="text-xs text-ink-muted">
          {pending.length} request{pending.length !== 1 ? "s" : ""} pending
        </p>
      )}
    </div>
  );
}
