import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/cn";

export const metadata = { title: "Trust Center — NoPM" };

interface AuditRow {
  id: string;
  action: string;
  actor_type: "user" | "token" | string;
  actor_label: string;
  target_type: string;
  target_id: string;
  created_at: string;
  meta?: Record<string, unknown> | null;
}

const COMMON_ACTIONS: { action: string; description: string }[] = [
  { action: "task.create", description: "A new task was created" },
  { action: "task.update", description: "A task field was mutated" },
  { action: "task.delete", description: "Hard delete committed after approval" },
  { action: "deletion_request.create", description: "Deletion request raised" },
  { action: "deletion_request.approve", description: "Second reviewer approved request" },
  { action: "deletion_request.reject", description: "Second reviewer rejected request" },
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

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export default async function TrustPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const { data: rows, error } = await db
    .from("audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  const entries: AuditRow[] = rows ?? [];

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader title="Trust Center" action={<Badge tone="accent">Immutable</Badge>} />

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/15 px-4 py-3 text-sm text-danger">
          Failed to load audit log: {error.message}
        </div>
      )}

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

                  {/* Entry body */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                      {/* Left side */}
                      <div className="space-y-1.5">
                        {/* Action badge */}
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            tone={actionToBadgeTone(entry.action)}
                            className="font-mono text-xs"
                          >
                            {entry.action}
                          </Badge>
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
                        </div>

                        {/* Target */}
                        <p className="text-xs text-ink-muted">
                          <span className="capitalize">{entry.target_type}</span>
                          <code className="ml-1.5 rounded bg-sunken px-1 py-0.5 font-mono text-ink-secondary">
                            {shortId(entry.target_id)}
                          </code>
                        </p>
                      </div>

                      {/* Right side: timestamp */}
                      <div className="shrink-0 text-right">
                        <time
                          dateTime={entry.created_at}
                          title={absoluteTime(entry.created_at)}
                          className="block text-xs font-medium text-ink-secondary"
                        >
                          {relativeTime(entry.created_at)}
                        </time>
                        <span className="block text-xs text-ink-muted">
                          {absoluteTime(entry.created_at)}
                        </span>
                      </div>
                    </div>
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
            </CardBody>
          </Card>
        </div>
      </div>
      </div>
    </div>
  );
}
