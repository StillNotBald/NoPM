import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { renderNotificationEmail } from "@/lib/notify/email";
import { SAMPLE_NOTIFICATIONS } from "./samples";

export const metadata = { title: "Email Previews" };

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

/** A row to preview: a real notification, or a sample (no timestamp). */
type PreviewRow = Omit<NotificationRow, "read_at" | "created_at"> & { created_at: string | null };

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

const TYPE_TONE: Record<string, "neutral" | "accent" | "success" | "warning" | "danger"> = {
  "approval.requested": "accent",
  "approval.approved": "success",
  "approval.rejected": "danger",
  "risk.escalated": "warning",
  "clash.detected": "warning",
  "item.stale": "warning",
  "report.weekly": "accent",
};

function typeTone(type: string): "neutral" | "accent" | "success" | "warning" | "danger" {
  return TYPE_TONE[type] ?? "neutral";
}

export default async function EmailPreviewsPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const { data: rows, error } = await db
    .from("notifications")
    .select("id, type, title, body, payload, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  const notifications: NotificationRow[] = rows ?? [];
  // Nothing delivered yet (and no read error): preview the template with one
  // labelled sample per notification type instead of an empty page.
  const isSample = !error && notifications.length === 0;
  const previews: PreviewRow[] = isSample
    ? SAMPLE_NOTIFICATIONS.map((s, i) => ({
        id: `sample-${i}`,
        type: s.type,
        title: s.title,
        body: s.body ?? null,
        payload: s.payload ?? null,
        created_at: null,
      }))
    : notifications;

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <PageHeader
          title="Email previews"
          action={<Badge tone="neutral">Demo mode</Badge>}
        />

        {/* Demo-mode banner */}
        <div
          role="note"
          className="flex items-start gap-3 rounded-lg border border-accent/30 bg-accent/8 px-4 py-3"
        >
          <span
            className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-accent"
            aria-hidden="true"
          />
          <p className="text-sm text-ink">
            <strong className="font-medium text-accent">Previews only</strong>
            {" — "}
            NoPM does not send email. Resend runs in demo-mode; this shows exactly what would be
            delivered to each recipient.
          </p>
        </div>

        {/* Error state — a generic line: the raw database message is not for the page. */}
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/15 px-4 py-3 text-sm text-danger-ink"
          >
            Could not load notifications. Reload the page to try again.
          </div>
        )}

        {/* Notification previews — real ones, or one labelled sample per type when there are none. */}
        {previews.length > 0 && (
          <div className="space-y-6">
            <p className="text-xs text-ink-muted">
              {isSample
                ? "No notifications yet, so these are samples: one per notification type, rendered with the same template."
                : notifications.length === 20
                  ? "Showing newest 20 notifications"
                  : `${notifications.length} notification${notifications.length === 1 ? "" : "s"}`}
            </p>
            {previews.map((n) => {
              const { subject, html } = renderNotificationEmail({
                type: n.type,
                title: n.title,
                body: n.body,
                payload: n.payload,
              });
              return (
                <Card key={n.id}>
                  <CardHeader>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <Badge tone={typeTone(n.type)} className="font-mono text-xs shrink-0">
                        {n.type}
                      </Badge>
                      <span className="min-w-0 truncate text-sm font-medium text-ink">
                        {subject}
                      </span>
                    </div>
                    {n.created_at ? (
                      <time
                        dateTime={n.created_at}
                        className="shrink-0 text-xs text-ink-muted"
                      >
                        {relativeTime(n.created_at)}
                      </time>
                    ) : (
                      <Badge tone="neutral" className="shrink-0">Sample</Badge>
                    )}
                  </CardHeader>
                  <CardBody pad="none" className="overflow-hidden rounded-b-lg">
                    {/* Sandboxed iframe — email styles are fully isolated.
                        Height caps at 60vh (min() keeps the existing 420px on
                        normal-height screens) so a short/landscape phone
                        viewport never has the preview pushed off-screen; the
                        iframe scrolls its own content if it's taller than
                        the visible box. */}
                    <iframe
                      srcDoc={html}
                      sandbox=""
                      title={`Email preview: ${subject}`}
                      className="w-full rounded-b-lg"
                      style={{ height: "min(420px, 60vh)", border: "none", display: "block" }}
                    />
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
