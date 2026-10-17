import { createAdminClient } from "@/lib/supabase/admin";
import { appBaseUrl } from "@/lib/integrations/store";
import { sanitizeError } from "@/lib/integrations/secrets";
import type { DigestData } from "@/lib/integrations/types";

/**
 * Gather the data a weekly digest renders — workspace-filtered, read-only,
 * and fail-soft per section: a failing query degrades that section to empty /
 * zero (and is logged) rather than blocking the whole digest. The adapter
 * renders it; nothing here knows what a Lark card looks like.
 */

const DUE_SOON_DAYS = 14;
const MAX_PROJECTS = 25;
const MAX_MILESTONES = 15;

/** Order projects so the ones needing attention lead the digest. */
const HEALTH_RANK: Record<string, number> = { red: 0, amber: 1, green: 2, not_started: 3, complete: 4 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;
type CountResult = { count: number | null; error: unknown };
type ProjectRow = { id: string; name: string; rag_status: string | null; is_locked: boolean | null };
type MilestoneRow = { id: string; name: string; project_id: string; target_date: string };

async function safe<T>(label: string, fallback: T, run: () => PromiseLike<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`[integrations] digest ${label} failed:`, sanitizeError(err));
    return fallback;
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function gatherDigestData(
  workspaceId: string,
  opts: { now?: Date; appUrl?: string } = {},
): Promise<DigestData> {
  const now = opts.now ?? new Date();
  const db = createAdminClient();
  const today = ymd(now);
  const horizon = ymd(new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000));

  const head = (table: string): Q =>
    db.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
  const count = async (table: string, build: (q: Q) => PromiseLike<CountResult>): Promise<number> => {
    const { count: n, error } = await build(head(table));
    if (error) throw error;
    return n ?? 0;
  };

  const [workspaceName, projects, milestones, openHighRisks, pendingApprovals] = await Promise.all([
    safe("workspace", "Workspace", async () => {
      const { data, error } = await db.from("workspaces").select("name").eq("id", workspaceId).maybeSingle();
      if (error) throw error;
      return (data?.name as string | undefined) ?? "Workspace";
    }),
    safe("projects", [] as ProjectRow[], async () => {
      const { data, error } = await db
        .from("projects")
        .select("id, name, rag_status, is_locked")
        .eq("workspace_id", workspaceId)
        .order("name", { ascending: true })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as ProjectRow[];
    }),
    safe("milestones", [] as MilestoneRow[], async () => {
      const { data, error } = await db
        .from("milestones")
        .select("id, name, project_id, target_date")
        .eq("workspace_id", workspaceId)
        .neq("status", "completed")
        .gte("target_date", today)
        .lte("target_date", horizon)
        .order("target_date", { ascending: true })
        .limit(MAX_MILESTONES);
      if (error) throw error;
      return (data ?? []) as MilestoneRow[];
    }),
    safe("risks", 0, () =>
      count("risks", (q) => q.in("severity", ["high", "critical"]).not("status", "in", '("closed","accepted")')),
    ),
    safe("approvals", 0, async () => {
      const [deletions, changes, timesheets, rebaselines] = await Promise.all([
        count("deletion_requests", (q) => q.eq("status", "pending")),
        count("change_requests", (q) => q.in("status", ["raised", "under_review"])),
        count("timesheet_submissions", (q) => q.eq("status", "submitted")),
        count("rebaselines", (q) => q.eq("status", "pending_approval")),
      ]);
      return deletions + changes + timesheets + rebaselines;
    }),
  ]);

  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const ranked = [...projects]
    .sort((a, b) => (HEALTH_RANK[a.rag_status ?? ""] ?? 9) - (HEALTH_RANK[b.rag_status ?? ""] ?? 9))
    .slice(0, MAX_PROJECTS);

  return {
    workspaceName,
    generatedAt: now.toISOString(),
    appUrl: opts.appUrl ?? appBaseUrl(),
    projects: ranked.map((p) => ({
      id: p.id,
      name: p.name,
      health: p.rag_status ?? null,
      status: p.is_locked ? "locked" : p.rag_status === "complete" ? "complete" : "active",
    })),
    milestonesDueSoon: milestones.map((m) => ({
      id: m.id,
      name: m.name,
      projectName: projectNames.get(m.project_id) ?? null,
      dueDate: m.target_date,
    })),
    openHighRisks,
    pendingApprovals,
  };
}
