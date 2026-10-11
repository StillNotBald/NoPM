import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { APPEARANCE_COOKIE_NAME, parseAppearancePrefs } from "@/lib/theme/appearance";
import { formatByPref } from "@/lib/format/dates";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  LockedBaselinesList,
  RebaselinesList,
  type LockedBaselineRow,
  type RebaselineRow as RebaselineListRow,
} from "@/components/baselines/baseline-lists";

// Baselines (R-78 sprint-1 follow-up): a nav home for the "lock → rebaseline
// → sign-off → apply" flow described in
// user-manual/operator/03-schedule-and-lock.md — previously only reachable
// by opening a project or the Review Queue. Read-only here: the write path
// stays the API/agent surfaces (CLI, MCP, BYOK assistant) exactly as that
// doc describes; this page just makes the flow's two record types legible
// in one place instead of hidden inside individual project pages.

type RebaselineStatus = "draft" | "pending_approval" | "approved" | "applied" | "rejected";

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
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const FLOW_EXPLAINER =
  "Lock a project to freeze its baseline; changes then require a rebaseline with sign-off from a different approver.";

export default async function BaselinesPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const dateDisplayPref = parseAppearancePrefs(
    (await cookies()).get(APPEARANCE_COOKIE_NAME)?.value,
  ).dateDisplay;

  const [{ data: projects }, { data: rebaselines }, { data: profiles }, { data: signoffs }] =
    await Promise.all([
      db
        .from("projects")
        .select("id, name, is_locked, locked_by, locked_at, lock_reason")
        .order("name"),
      db
        .from("rebaselines")
        .select("id, project_id, status, reason, created_at")
        .order("created_at", { ascending: false }),
      // locked_by → display name. Cheap workspace-wide read (RLS-scoped),
      // same pattern as risks/page.tsx's ownerMap.
      db.from("profiles").select("id, display_name, email"),
      db.from("rebaseline_signoffs").select("rebaseline_id, vote"),
    ]);

  const projectList = (projects ?? []) as ProjectRow[];
  const rebaselineList = (rebaselines ?? []) as RebaselineRow[];

  const projectMap = Object.fromEntries(projectList.map((p) => [p.id, p.name]));

  const profileMap = new Map<string, string>();
  for (const p of profiles ?? []) {
    profileMap.set(p.id, p.display_name ?? p.email ?? p.id.slice(0, 8) + "…");
  }
  function labelFor(id: string | null) {
    if (!id) return "—";
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

  const lockedBaselineRows: LockedBaselineRow[] = lockedProjects.map((p) => {
    const lockedAt = formatByPref(p.locked_at, dateDisplayPref);
    return {
      id: p.id,
      name: p.name,
      lockedAtText: lockedAt.text,
      lockedAtTitle: lockedAt.title,
      lockedByLabel: labelFor(p.locked_by),
      lockReason: p.lock_reason,
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
      signoffLabel: counts ? `${counts.cast} / ${counts.total}` : "—",
    };
  });

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div>
          <PageHeader title="Baselines" />
          <p className="-mt-3 mb-1 text-sm text-ink-muted">
            Locked timelines and the rebaselines that reopen them. Every step is audited.
          </p>
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
      </div>
    </div>
  );
}
