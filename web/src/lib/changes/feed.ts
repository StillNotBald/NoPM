import { entityHref, type EntityKind } from "@/lib/nav/entity-href";
import { shiftToZone } from "@/lib/integrations/time-zone";

/**
 * "What changed" feed (R-143, audit item A5): the audit trail across ALL
 * projects, grouped by day, with the project code, who did it (the human
 * behind a token when there is one), what was done and the title of the thing
 * it was done to.
 *
 * Read-only. The audit query is the same one GET /api/audit runs (this module's
 * `applyFeedFilters` is shared by both); titles and project codes are resolved
 * in BATCHED lookups, at most one per record type for the page, never one query
 * per row.
 */

export const FEED_KINDS = ["task", "risk", "issue", "change_request", "decision", "document", "project"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export const FEED_KIND_LABELS: Record<FeedKind, string> = {
  task: "Task",
  risk: "Risk",
  issue: "Issue",
  change_request: "Change request",
  decision: "Decision",
  document: "Document",
  project: "Project",
};

export const FEED_PAGE_SIZE = 50;

export type FeedFilters = {
  projectId?: string;
  /** Empty / absent = no restriction here; the console feed itself defaults to FEED_KINDS. */
  kinds?: FeedKind[];
  /** A person: matches rows they did themselves and rows done through a token they own. */
  actorId?: string;
  /** Inclusive lower bound, ISO timestamp. */
  from?: string;
  /** Exclusive upper bound, ISO timestamp. */
  to?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export const isFeedKind = (v: unknown): v is FeedKind => (FEED_KINDS as readonly string[]).includes(v as string);

/**
 * Apply the feed filters to an `audit_log` query. Values that reach a PostgREST
 * `or()` expression are UUID-checked first (a filter string is not escaped for
 * you), and an invalid id matches nothing rather than being ignored.
 *
 * Project filter: an audit row carries no project column, so a row belongs to a
 * project when it IS the project, or its recorded before/after row says so
 * (every task, risk, issue, change request, decision and document write stores
 * the row it wrote, which includes `project_id`).
 */
export function applyFeedFilters<Q>(query: Q, f: FeedFilters): Q {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = query;
  if (f.kinds && f.kinds.length > 0) q = q.in("target_type", f.kinds);
  if (f.projectId !== undefined) {
    if (!isUuid(f.projectId)) return q.eq("id", "00000000-0000-0000-0000-000000000000");
    const p = f.projectId;
    q = q.or(`target_id.eq.${p},after->>project_id.eq.${p},before->>project_id.eq.${p}`);
  }
  if (f.actorId !== undefined) {
    if (!isUuid(f.actorId)) return q.eq("id", "00000000-0000-0000-0000-000000000000");
    q = q.or(`actor_id.eq.${f.actorId},principal_id.eq.${f.actorId}`);
  }
  if (f.from !== undefined) q = q.gte("created_at", f.from);
  if (f.to !== undefined) q = q.lt("created_at", f.to);
  return q;
}

export type FeedRow = {
  id: string;
  createdAt: string;
  /** YYYY-MM-DD in the workspace time zone. */
  day: string;
  actorLabel: string;
  /** The person behind a token or connector, when known and different from the label. */
  onBehalfOf: string | null;
  action: string;
  kind: FeedKind;
  targetId: string | null;
  targetTitle: string;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  href: string | null;
};

export type FeedPage = { rows: FeedRow[]; total: number; page: number; pageSize: number; error: string | null };

/** Start (UTC instant) of a calendar day in a time zone. */
export function zonedDayStartUtc(day: string, timeZone: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const offset = shiftToZone(new Date(guess), timeZone).getTime() - guess;
  return new Date(guess - offset);
}

const TITLE_SOURCES: Record<Exclude<FeedKind, "project">, { table: string; titleCol: string }> = {
  task: { table: "tasks", titleCol: "name" },
  risk: { table: "risks", titleCol: "title" },
  issue: { table: "issues", titleCol: "title" },
  change_request: { table: "change_requests", titleCol: "title" },
  decision: { table: "decisions", titleCol: "title" },
  document: { table: "documents", titleCol: "title" },
};

function snapshotTitle(row: Row): string | null {
  for (const side of [row.after, row.before]) {
    if (side && typeof side === "object") {
      const o = side as Row;
      const t = o.title ?? o.name;
      if (typeof t === "string" && t.trim()) return t;
    }
  }
  return null;
}

function snapshotProjectId(row: Row): string | null {
  for (const side of [row.after, row.before]) {
    if (side && typeof side === "object") {
      const p = (side as Row).project_id;
      if (isUuid(p)) return p;
    }
  }
  return null;
}

export function dayOf(iso: string, timeZone: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? shiftToZone(new Date(t), timeZone).toISOString().slice(0, 10) : iso.slice(0, 10);
}

const PROJECT_TABLES = ["tasks", "risks", "issues", "change_requests", "decisions", "documents"] as const;
const TABLE_KIND: Record<(typeof PROJECT_TABLES)[number], FeedKind> = {
  tasks: "task",
  risks: "risk",
  issues: "issue",
  change_requests: "change_request",
  decisions: "decision",
  documents: "document",
};
/** Most audit rows one source contributes to a project-filtered feed (newest first). */
const PROJECT_FEED_CAP = 2000;
const TARGET_CHUNK = 80;

/**
 * Ids of the audit rows for a project, newest first: rows whose payload names the project
 * UNION rows whose target is one of the project's records (resolved by those tables' own
 * project_id, in batched lookups). The one case neither can reach: a workspace-level record
 * (no project) or a row with no payload and a record that has since been deleted.
 */
async function projectScopedIds(
  db: Db,
  workspaceId: string,
  filters: FeedFilters,
): Promise<{ ids: string[]; error: string | null }> {
  const projectId = filters.projectId as string;
  const seen = new Map<string, string>();
  const take = (rows: Row[] | null) => {
    for (const r of rows ?? []) seen.set(String(r.id), String(r.created_at));
  };
  const light = () => db.from("audit_log").select("id, created_at").eq("workspace_id", workspaceId);

  const viaPayload = await applyFeedFilters(light(), filters).order("created_at", { ascending: false }).limit(PROJECT_FEED_CAP);
  if (viaPayload.error) return { ids: [], error: viaPayload.error.message ?? "The audit trail could not be read" };
  take(viaPayload.data);

  const targets: string[] = [];
  const wanted = new Set(filters.kinds ?? FEED_KINDS);
  for (const table of PROJECT_TABLES) {
    if (!wanted.has(TABLE_KIND[table])) continue;
    const res = await db.from(table).select("id").eq("workspace_id", workspaceId).eq("project_id", projectId).limit(PROJECT_FEED_CAP);
    if (res.error) return { ids: [], error: res.error.message ?? "The project's records could not be read" };
    for (const r of (res.data ?? []) as Row[]) targets.push(String(r.id));
  }
  // The other filters (kind, person, dates) apply to the by-target rows too; the project filter itself does not.
  const rest: FeedFilters = { ...filters, projectId: undefined };
  for (let i = 0; i < targets.length; i += TARGET_CHUNK) {
    const res = await applyFeedFilters(light(), rest)
      .in("target_id", targets.slice(i, i + TARGET_CHUNK))
      .order("created_at", { ascending: false })
      .limit(PROJECT_FEED_CAP);
    if (res.error) return { ids: [], error: res.error.message ?? "The audit trail could not be read" };
    take(res.data);
  }
  const ids = [...seen.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .map(([id]) => id)
    .slice(0, PROJECT_FEED_CAP);
  return { ids, error: null };
}

/**
 * One page of the feed, newest first. `db` is any Supabase client (the console
 * page passes the session client, the API passes the admin client); every query
 * is filtered by `workspaceId` either way.
 */
export async function gatherChangeFeed(
  db: Db,
  workspaceId: string,
  filters: FeedFilters,
  opts: { page?: number; pageSize?: number; timeZone: string },
): Promise<FeedPage> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? FEED_PAGE_SIZE));
  const empty = (error: string | null): FeedPage => ({ rows: [], total: 0, page, pageSize, error });

  const kinds = filters.kinds && filters.kinds.length > 0 ? filters.kinds : [...FEED_KINDS];
  const cols = "id, created_at, actor_type, actor_id, actor_label, principal_id, action, target_type, target_id, before, after";
  let audit: Row[];
  let total: number;
  if (filters.projectId !== undefined && isUuid(filters.projectId)) {
    // A project filter does not trust the audit payload alone: it also resolves the project's
    // records by their own project_id and matches the audit rows by target, then unions both.
    const got = await projectScopedIds(db, workspaceId, { ...filters, kinds });
    if (got.error) return empty(got.error);
    total = got.ids.length;
    const pageIds = got.ids.slice((page - 1) * pageSize, page * pageSize);
    if (pageIds.length === 0) return { rows: [], total, page, pageSize, error: null };
    const res = await db.from("audit_log").select(cols).eq("workspace_id", workspaceId).in("id", pageIds);
    if (res.error) return empty(res.error.message ?? "The audit trail could not be read");
    const order = new Map(pageIds.map((id, i) => [id, i]));
    audit = ((res.data ?? []) as Row[]).sort((a, b) => order.get(String(a.id))! - order.get(String(b.id))!);
  } else {
    const base = db.from("audit_log").select(cols, { count: "exact" }).eq("workspace_id", workspaceId);
    const { data, error, count } = await applyFeedFilters(base, { ...filters, kinds })
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (error) return empty(error.message ?? "The audit trail could not be read");
    audit = (data ?? []) as Row[];
    total = count ?? audit.length;
  }
  if (audit.length === 0) return { rows: [], total, page, pageSize, error: null };

  // Batch 1: current titles (and project ids) per record type, one query each.
  const idsByKind = new Map<FeedKind, Set<string>>();
  for (const r of audit) {
    const kind = r.target_type as FeedKind;
    if (isUuid(r.target_id)) (idsByKind.get(kind) ?? idsByKind.set(kind, new Set()).get(kind)!).add(r.target_id);
  }
  const titles = new Map<string, { title: string; projectId: string | null }>();
  const projectIds = new Set<string>();
  await Promise.all(
    [...idsByKind.entries()].map(async ([kind, ids]) => {
      if (kind === "project") {
        for (const id of ids) projectIds.add(id);
        return;
      }
      const src = TITLE_SOURCES[kind];
      if (!src) return;
      const res = await db
        .from(src.table)
        .select(`id, ${src.titleCol}, project_id`)
        .eq("workspace_id", workspaceId)
        .in("id", [...ids]);
      if (res.error) return; // a failed title lookup degrades to the audit snapshot, never the whole feed
      for (const t of (res.data ?? []) as Row[]) {
        const pid = isUuid(t.project_id) ? t.project_id : null;
        titles.set(`${kind}:${t.id}`, { title: String(t[src.titleCol] ?? ""), projectId: pid });
        if (pid) projectIds.add(pid);
      }
    }),
  );
  for (const r of audit) {
    const pid = snapshotProjectId(r);
    if (pid) projectIds.add(pid);
  }

  // Batch 2: project codes and names, plus the people behind tokens.
  const principalIds = [...new Set(audit.filter((r) => r.actor_type === "token" && isUuid(r.principal_id)).map((r) => r.principal_id as string))];
  const [projectRes, peopleRes] = await Promise.all([
    projectIds.size > 0
      ? db.from("projects").select("id, code, name").eq("workspace_id", workspaceId).in("id", [...projectIds])
      : Promise.resolve({ data: [], error: null }),
    principalIds.length > 0
      ? db.from("profiles").select("id, display_name, email").eq("workspace_id", workspaceId).in("id", principalIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const projects = new Map<string, { code: string | null; name: string | null }>();
  for (const p of (projectRes.data ?? []) as Row[]) {
    projects.set(String(p.id), { code: (p.code as string | null) ?? null, name: (p.name as string | null) ?? null });
  }
  const people = new Map<string, string>();
  for (const p of (peopleRes.data ?? []) as Row[]) {
    people.set(String(p.id), String(p.display_name || p.email || ""));
  }

  const rows: FeedRow[] = audit.map((r) => {
    const kind = r.target_type as FeedKind;
    const targetId = isUuid(r.target_id) ? r.target_id : null;
    const resolved = targetId ? titles.get(`${kind}:${targetId}`) : undefined;
    const projectId =
      kind === "project" ? targetId : (resolved?.projectId ?? snapshotProjectId(r));
    const project = projectId ? projects.get(projectId) : undefined;
    const title =
      kind === "project" && project?.name
        ? project.name
        : (resolved?.title || snapshotTitle(r) || "(removed)");
    const principal = r.actor_type === "token" && isUuid(r.principal_id) ? (people.get(r.principal_id) ?? null) : null;
    const actorLabel = String(r.actor_label ?? "");
    return {
      id: String(r.id),
      createdAt: String(r.created_at),
      day: dayOf(String(r.created_at), opts.timeZone),
      actorLabel,
      onBehalfOf: principal && principal !== actorLabel ? principal : null,
      action: String(r.action),
      kind,
      targetId,
      targetTitle: title,
      projectId,
      projectCode: project?.code ?? null,
      projectName: project?.name ?? null,
      // A record that no longer exists has nowhere to link to.
      href: targetId && (kind === "project" || resolved !== undefined) ? entityHref(kind as EntityKind, { id: targetId, projectId }) : null,
    };
  });
  return { rows, total, page, pageSize, error: null };
}

/** Group newest-first rows into per-day sections, keeping order. */
export function groupByDay(rows: FeedRow[]): { day: string; rows: FeedRow[] }[] {
  const out: { day: string; rows: FeedRow[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.day === r.day) last.rows.push(r);
    else out.push({ day: r.day, rows: [r] });
  }
  return out;
}

