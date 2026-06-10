// Mainline — the portfolio "governance throughline" graph. One governed read
// assembles every artifact (milestone/task/risk/issue/decision/doc/SteerCo)
// across the workspace into a lens-agnostic graph the client renders three ways
// (Subway / Journal / Network). Workspace-scoped; callers pass a client already
// bound to the actor's workspace (session client = RLS; admin client = explicit
// .eq("workspace_id") below).
import type { SupabaseClient } from "@supabase/supabase-js";
import { entityHref, type EntityKind } from "@/lib/nav/entity-href";

export type TLKind = "milestone" | "task" | "risk" | "issue" | "decision" | "doc" | "steerco";

export interface TLNode {
  id: string;
  kind: TLKind;
  label: string;
  refId: string | null;
  projectId: string | null;
  date: string; // anchor (ISO date)
  endDate: string | null; // optional bar span (tasks)
  status: string | null;
  severity: "low" | "medium" | "high" | "critical" | null;
  completionPct: number | null;
  href: string | null;
  onCriticalPath: boolean;
}

export type TLEdgeKind = "sequence" | "clash" | "feeder";
export interface TLEdge {
  from: string;
  to: string;
  kind: TLEdgeKind;
  critical: boolean;
  label?: string;
}

export interface TLProject {
  id: string;
  code: string;
  name: string;
  color: string;
  ragStatus: string;
}

export interface TLGraph {
  projects: TLProject[];
  nodes: TLNode[];
  edges: TLEdge[];
  axis: { start: string; end: string; today: string; steercoDates: string[] };
  criticalProjectId: string | null;
  counts: Record<TLKind, number>;
}

// 6 metro-line colors (coral reserved as the critical-path overlay)
const PALETTE = ["#3F8E7E", "#5B6CB8", "#C98A2B", "#A65574", "#4E7CA1", "#7A8B3C"];
const SEV = new Set(["low", "medium", "high", "critical"]);
const sev = (s: unknown) => (typeof s === "string" && SEV.has(s) ? (s as TLNode["severity"]) : null);

const TODAY = "2026-06-09"; // demo "now" (kept stable so the Today line is deterministic)

export async function gatherTimeline(db: SupabaseClient, workspaceId: string): Promise<TLGraph> {
  const pick = async (t: string, cols: string) =>
    ((await db.from(t).select(cols).eq("workspace_id", workspaceId)).data ?? []) as unknown as Record<string, unknown>[];

  const [projects, milestones, tasks, risks, issues, decisions, documents, clashes] = await Promise.all([
    pick("projects", "id, code, name, rag_status"),
    pick("milestones", "id, project_id, name, target_date, baseline_target_date, status, completion_pct"),
    pick("tasks", "id, project_id, name, start_date, due_date, status_type, completion_pct"),
    pick("risks", "id, project_id, title, severity, status, raised_at, reference_id"),
    pick("issues", "id, project_id, title, priority, status, raised_at, reference_id"),
    pick("decisions", "id, project_id, title, status, decided_at, created_at, reference_id"),
    pick("documents", "id, project_id, title, doc_type, status, created_at, reference_id"),
    pick("clashes", "id, title, type, project_a_id, project_b_id, window_start, reference_id"),
  ]);

  // ── projects + stable colors (sorted by code) ────────────────────────────────
  const order = [...projects].sort((a, b) => String(a.code ?? "").localeCompare(String(b.code ?? "")));
  const color: Record<string, string> = {};
  const tlProjects: TLProject[] = order.map((p, i) => {
    color[p.id as string] = PALETTE[i % PALETTE.length];
    return { id: p.id as string, code: String(p.code ?? ""), name: String(p.name ?? ""), color: PALETTE[i % PALETTE.length], ragStatus: String(p.rag_status ?? "") };
  });

  // critical-path project: first red, else first amber, else the one with most milestones
  const msByProject = new Map<string, Record<string, unknown>[]>();
  for (const m of milestones) {
    const pid = m.project_id as string;
    if (!msByProject.has(pid)) msByProject.set(pid, []);
    msByProject.get(pid)!.push(m);
  }
  for (const arr of msByProject.values()) arr.sort((a, b) => String(a.target_date).localeCompare(String(b.target_date)));
  const criticalProjectId =
    order.find((p) => p.rag_status === "red")?.id as string | undefined ??
    order.find((p) => p.rag_status === "amber")?.id as string | undefined ??
    [...order].sort((a, b) => (msByProject.get(b.id as string)?.length ?? 0) - (msByProject.get(a.id as string)?.length ?? 0))[0]?.id as string | undefined ??
    null;

  const nodes: TLNode[] = [];
  const edges: TLEdge[] = [];
  const dates: string[] = [];
  const push = (n: TLNode) => { nodes.push(n); if (n.date) dates.push(n.date); if (n.endDate) dates.push(n.endDate); };

  // ── milestones (+ per-project sequence edges, critical overlay) ───────────────
  for (const m of milestones) {
    if (!m.target_date) continue;
    const pid = m.project_id as string;
    push({
      id: m.id as string, kind: "milestone", label: String(m.name ?? ""), refId: null, projectId: pid,
      date: String(m.target_date), endDate: (m.baseline_target_date as string) ?? null,
      status: (m.status as string) ?? null, severity: null,
      completionPct: (m.completion_pct as number) ?? null,
      href: entityHref("milestone", { id: m.id as string, projectId: pid }),
      onCriticalPath: pid === criticalProjectId,
    });
  }
  for (const [pid, arr] of msByProject) {
    for (let i = 1; i < arr.length; i++) {
      edges.push({ from: arr[i - 1].id as string, to: arr[i].id as string, kind: "sequence", critical: pid === criticalProjectId });
    }
  }

  const nearestMs = (pid: string, iso: string | null) => {
    const arr = msByProject.get(pid); if (!arr?.length) return null;
    let best = arr[0], bd = Infinity;
    for (const m of arr) { const d = Math.abs(+new Date(String(m.target_date)) - +new Date(iso ?? TODAY)); if (d < bd) { bd = d; best = m; } }
    return best;
  };

  // ── tasks ─────────────────────────────────────────────────────────────────────
  for (const t of tasks) {
    const d = (t.due_date as string) ?? (t.start_date as string) ?? null; if (!d) continue;
    const pid = t.project_id as string;
    push({
      id: t.id as string, kind: "task", label: String(t.name ?? ""), refId: null, projectId: pid,
      date: d, endDate: (t.start_date as string) ?? null,
      status: (t.status_type as string) ?? null, severity: null,
      completionPct: (t.completion_pct as number) ?? null,
      href: entityHref("task", { id: t.id as string, projectId: pid }),
      onCriticalPath: false,
    });
  }

  // ── risks (+ fishbone feeder edges for high/critical) ─────────────────────────
  for (const r of risks) {
    if (!r.raised_at) continue;
    const pid = r.project_id as string;
    push({
      id: r.id as string, kind: "risk", label: String(r.title ?? ""), refId: (r.reference_id as string) ?? null, projectId: pid,
      date: String(r.raised_at), endDate: null, status: (r.status as string) ?? null, severity: sev(r.severity),
      completionPct: null, href: entityHref("risk", { id: r.id as string }), onCriticalPath: false,
    });
    if (r.severity === "high" || r.severity === "critical") {
      const m = nearestMs(pid, r.raised_at as string);
      if (m) edges.push({ from: r.id as string, to: m.id as string, kind: "feeder", critical: false });
    }
  }

  // ── issues / decisions / docs ─────────────────────────────────────────────────
  for (const it of issues) {
    if (!it.raised_at) continue;
    push({
      id: it.id as string, kind: "issue", label: String(it.title ?? ""), refId: (it.reference_id as string) ?? null,
      projectId: it.project_id as string, date: String(it.raised_at), endDate: null,
      status: (it.status as string) ?? null, severity: sev(it.priority), completionPct: null,
      href: entityHref("issue", { id: it.id as string }), onCriticalPath: false,
    });
  }
  for (const dc of decisions) {
    const d = (dc.decided_at as string) ?? (dc.created_at as string) ?? null; if (!d) continue;
    push({
      id: dc.id as string, kind: "decision", label: String(dc.title ?? ""), refId: (dc.reference_id as string) ?? null,
      projectId: (dc.project_id as string) ?? null, date: d, endDate: null,
      status: (dc.status as string) ?? null, severity: null, completionPct: null,
      href: entityHref("decision", { id: dc.id as string }), onCriticalPath: false,
    });
  }
  for (const dd of documents) {
    if (!dd.created_at) continue;
    push({
      id: dd.id as string, kind: "doc", label: String(dd.title ?? ""), refId: (dd.reference_id as string) ?? null,
      projectId: (dd.project_id as string) ?? null, date: String(dd.created_at), endDate: null,
      status: (dd.doc_type as string) ?? null, severity: null, completionPct: null,
      href: entityHref("document", { id: dd.id as string }), onCriticalPath: false,
    });
  }

  // ── date domain + synthesised quarterly SteerCo gates ────────────────────────
  const ms = dates.map((d) => +new Date(d)).filter((n) => !Number.isNaN(n));
  const minD = new Date(Math.min(...ms, +new Date(TODAY)));
  const maxD = new Date(Math.max(...ms, +new Date(TODAY)));
  minD.setDate(minD.getDate() - 10);
  maxD.setDate(maxD.getDate() + 14);
  const steercoDates: string[] = [];
  {
    const q = new Date(minD.getFullYear(), Math.ceil((minD.getMonth() + 1) / 3) * 3, 0);
    while (q <= maxD) {
      const iso = q.toISOString().slice(0, 10);
      steercoDates.push(iso);
      push({ id: `steerco-${iso}`, kind: "steerco", label: "SteerCo gate", refId: null, projectId: null, date: iso, endDate: null, status: null, severity: null, completionPct: null, href: null, onCriticalPath: false });
      q.setMonth(q.getMonth() + 3);
    }
  }

  // ── cross-project clash interchanges ─────────────────────────────────────────
  for (const c of clashes) {
    const a = c.project_a_id as string | null, b = c.project_b_id as string | null;
    if (!a || !b) continue;
    const ma = nearestMs(a, (c.window_start as string) ?? null), mb = nearestMs(b, (c.window_start as string) ?? null);
    if (ma && mb) edges.push({ from: ma.id as string, to: mb.id as string, kind: "clash", critical: false, label: String(c.reference_id ?? "clash") });
  }

  const counts = nodes.reduce((acc, n) => { acc[n.kind] = (acc[n.kind] ?? 0) + 1; return acc; }, {} as Record<TLKind, number>);

  return {
    projects: tlProjects,
    nodes,
    edges,
    axis: { start: minD.toISOString().slice(0, 10), end: maxD.toISOString().slice(0, 10), today: TODAY, steercoDates },
    criticalProjectId,
    counts,
  };
}
