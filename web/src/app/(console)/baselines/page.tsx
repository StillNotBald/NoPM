import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { APPEARANCE_COOKIE_NAME, parseAppearancePrefs } from "@/lib/theme/appearance";
import { formatByPref } from "@/lib/format/dates";
import { Card } from "@/components/ui/card";
import { rebaselineActionsFor } from "@/components/baselines/rebaseline-rules";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { FourEyesNote } from "@/components/governance/four-eyes-note";
import {
  LockedBaselinesList,
  RebaselinesList,
  type LockedBaselineRow,
  type RebaselineRow as RebaselineListRow,
} from "@/components/baselines/baseline-lists";

// Baselines (R-78 sprint-1 follow-up): a nav home for the "lock → rebaseline
// → sign-off → apply" flow described in
// user-manual/operator/03-schedule-and-lock.md. D1 / Q-GOV-6: the whole
// governed flow (propose, sign off go / no-go, apply) now has web controls
// here, calling the same API routes the CLI and agents use; admins and
// managers only for sign-off and apply (D-16), never the proposer.

export const metadata = { title: "Baselines" };

type RebaselineStatus = "draft" | "pending_approval" | "approved" | "applied" | "rejected" | "cancelled";

interface ProjectRow {
  id: string;
  name: string;
  is_locked: boolean;
  locked_by: string | null;
  locked_at: string | null;
  lock_reason: string | null;
}

interface RebaselineRow {
  id: string;
  project_id: string;
  status: string;
  reason: string | null;
  created_at: string;
  requested_by: string | null;
  requested_principal_id: string | null;
  after: unknown;
}

/** "1 Nov 2026 to 15 Dec 2026" from the dates the proposal recorded (Q-GOV-8). */
function proposedDatesText(after: unknown, pref: Parameters<typeof formatByPref>[1]): string | null {
  if (!after || typeof after !== "object" || Array.isArray(after)) return null;
  const a = after as { start_date?: unknown; target_date?: unknown };
  const fmt = (v: unknown) => (typeof v === "string" && v ? formatByPref(v, pref).text : null);
  const start = fmt(a.start_date);
  const end = fmt(a.target_date);
  if (start && end) return `${start} to ${end}`;
  return end ? `ends ${end}` : start ? `starts ${start}` : null;
}

interface SignoffRow {
  rebaseline_id: string;
  vote: string;
}

function statusTone(s: RebaselineStatus) {
  if (s === "applied" || s === "approved") return "success" as const;
  if (s === "rejected") return "danger" as const;
  if (s === "pending_approval") return "warning" as const;
  return "neutral" as const; // draft
}

function statusLabel(s: string) {
  // A cancelled rebaseline is always the work of an unlock (migration 0058).
  if (s === "cancelled") return "Cancelled — project unlocked";
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const FLOW_EXPLAINER =
  "Lock a project to freeze its baseline; changes then require a rebaseline with sign-off from a different approver.";

export default async function BaselinesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const rawFocus = Array.isArray(sp.focus) ? sp.focus[0] : sp.focus;
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const dateDisplayPref = parseAppearancePrefs(
    (await cookies()).get(APPEARANCE_COOKIE_NAME)?.value,
  ).dateDisplay;

  const [{ data: projects }, { data: rebaselines }, { data: profiles }, { data: signoffs }, { data: viewerProfile }] =
    await Promise.all([
      db
        .from("projects")
        .select("id, name, is_locked, locked_by, locked_at, lock_reason")
        .order("name"),
      db
        .from("rebaselines")
        .select("id, project_id, status, reason, created_at, requested_by, requested_principal_id, after")
        .order("created_at", { ascending: false }),
      // locked_by → display name. Cheap workspace-wide read (RLS-scoped),
      // same pattern as risks/page.tsx's ownerMap.
      db.from("profiles").select("id, display_name, email"),
      db.from("rebaseline_signoffs").select("rebaseline_id, vote"),
      db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    ]);
  // Who locked (migration 0088). Separate and fail-soft: a build live a moment before the
  // migration still renders, falling back to the locked_by profile name.
  const { data: lockLabelRows } = await db.from("projects").select("id, locked_by_label");
  const lockLabelById = new Map<string, string>();
  for (const r of (lockLabelRows ?? []) as { id: string; locked_by_label?: string | null }[]) {
    if (r.locked_by_label) lockLabelById.set(r.id, r.locked_by_label);
  }
  const viewerRole = (viewerProfile?.role as string | null | undefined) ?? null;
  const canPropose = viewerRole !== null && viewerRole !== "viewer";

  const projectList = (projects ?? []) as ProjectRow[];
  const rebaselineList = (rebaselines ?? []) as RebaselineRow[];

  const projectMap = Object.fromEntries(projectList.map((p) => [p.id, p.name]));

  const profileMap = new Map<string, string>();
  for (const p of profiles ?? []) {
    profileMap.set(p.id, p.display_name ?? p.email ?? p.id.slice(0, 8) + "…");
  }
  function labelFor(id: string | null) {
    if (!id) return "Not recorded";
    return profileMap.get(id) ?? id.slice(0, 8) + "…";
  }

  // sign-off count per rebaseline: cast votes (go/no_go) out of total rows.
  const signoffCounts = new Map<string, { cast: number; total: number }>();
  for (const s of (signoffs ?? []) as SignoffRow[]) {
    const cur = signoffCounts.get(s.rebaseline_id) ?? { cast: 0, total: 0 };
    cur.total += 1;
    if (s.vote !== "pending") cur.cast += 1;
    signoffCounts.set(s.rebaseline_id, cur);
  }

  const lockedProjects = projectList
    .filter((p) => p.is_locked)
    .sort((a, b) => (b.locked_at ?? "").localeCompare(a.locked_at ?? ""));

  const pendingProjects = new Set(
    rebaselineList.filter((r) => r.status === "pending_approval").map((r) => r.project_id),
  );

  const lockedBaselineRows: LockedBaselineRow[] = lockedProjects.map((p) => {
    const lockedAt = formatByPref(p.locked_at, dateDisplayPref);
    return {
      id: p.id,
      name: p.name,
      // A lock with no timestamp (seed data, older rows) says so instead of a bare dash.
      lockedAtText: p.locked_at ? lockedAt.text : "Not recorded",
      lockedAtTitle: p.locked_at ? lockedAt.title : "No lock time was recorded",
      lockedByLabel: lockLabelById.get(p.id) ?? labelFor(p.locked_by),
      lockReason: p.lock_reason,
      canPropose,
      proposeDisabledReason: pendingProjects.has(p.id) ? "A rebaseline is already awaiting sign-off for this project." : null,
    };
  });

  const rebaselineRows: RebaselineListRow[] = rebaselineList.map((r) => {
    const requested = formatByPref(r.created_at, dateDisplayPref);
    const counts = signoffCounts.get(r.id);
    return {
      id: r.id,
      projectId: r.project_id,
      projectName: projectMap[r.project_id] ?? r.project_id.slice(0, 8) + "…",
      status: r.status,
      statusLabel: statusLabel(r.status),
      statusTone: statusTone(r.status as RebaselineStatus),
      requestedText: requested.text,
      requestedTitle: requested.title,
      signoffLabel: counts ? `${counts.cast} of ${counts.total} cast` : "None yet",
      proposedDates: proposedDatesText(r.after, dateDisplayPref),
      focused: r.id === rawFocus,
      actions: rebaselineActionsFor({
        status: r.status,
        viewerId: user.id,
        viewerRole,
        requestedBy: r.requested_by,
        requestedPrincipalId: r.requested_principal_id,
      }),
    };
  });

  return (
    <PageContainer className="space-y-6">
        <div className="space-y-1">
          <PageHeader title="Baselines" />
          <p className="-mt-3 text-sm text-ink-muted">
            Locked timelines and the rebaselines that reopen them. Every step is audited.
          </p>
          {/* The sign-off rule stays visible once there are rows; it used to show only when empty. */}
          <FourEyesNote variant="quiet" />
        </div>

        {/* Locked baselines */}
        <Card>
          <div className="border-b border-border-subtle px-5 py-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Locked baselines
            </h2>
          </div>
          <LockedBaselinesList rows={lockedBaselineRows} purpose={FLOW_EXPLAINER} />
        </Card>

        {/* Rebaselines */}
        <Card>
          <div className="border-b border-border-subtle px-5 py-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Rebaselines
            </h2>
          </div>
          <RebaselinesList rows={rebaselineRows} purpose={FLOW_EXPLAINER} />
        </Card>
    </PageContainer>
  );
}
