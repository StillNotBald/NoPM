/**
 * Handover / key-person report (audit gap M6, R-140).
 *
 * "Runs without you": for every project in scope, the open items (the project
 * itself, its risks, issues and tasks) that have an owner but no backup, grouped
 * by owner; the open items nobody owns; and a workspace key-person matrix that
 * says who is a single point of failure.
 *
 * Pure computation lives in `buildHandover` (no database); `gatherHandover`
 * reads the rows, always filtered by workspace.
 *
 * Open means not finished, by the one shared definition in `lib/work/open.ts`
 * (also used by the stale nudges): status not in done, canceled, cancelled, closed,
 * resolved, completed, withdrawn. A project is also finished when its health is
 * `complete`. A backlog task and an accepted risk are open.
 *
 * People: projects, risks and issues are owned by a login profile; a task is
 * assigned to a resource member, who bridges to a login through
 * resource_members.profile_id. One human is one row in the matrix: a resource
 * member with a linked login counts as that login.
 */

import { isOpenStatus } from "@/lib/work/open";

export type ItemType = "project" | "risk" | "issue" | "task";

export type ProjectRow = {
  id: string; code: string | null; name: string; owner_id: string | null;
  backup_owner_id: string | null; rag_status: string | null;
};
export type RiskRow = {
  id: string; project_id: string; reference_id: string | null; title: string; status: string | null;
  owner_id: string | null; backup_owner_id: string | null;
};
export type IssueRow = RiskRow;
export type TaskRow = {
  id: string; project_id: string; name: string; status: string | null; status_type: string | null;
  assignee_id: string | null; backup_assignee_id: string | null;
};
export type ProfileRow = { id: string; display_name: string | null; email: string | null };
export type MemberRow = { id: string; name: string; profile_id: string | null };

export type PersonRef = { key: string; kind: "profile" | "resource_member"; id: string; label: string };

export type HandoverItem = {
  type: ItemType;
  id: string;
  reference: string | null;
  title: string;
  status: string | null;
};

export type OwnerGroup = {
  person: PersonRef;
  counts: { project: number; risk: number; issue: number; task: number; total: number };
  items: HandoverItem[];
};

export type ProjectHandover = {
  project: { id: string; code: string | null; name: string };
  open_items: number;
  without_backup: number;
  unowned: number;
  owners: OwnerGroup[];
  unowned_items: HandoverItem[];
};

export type KeyPerson = {
  person: PersonRef;
  /** Open items this person owns with no backup named. */
  sole_items: number;
  /** Projects where this person owns or backs up an open item. */
  projects_touched: number;
  /** Open items where this person is the named backup. */
  backup_items: number;
  /** True when this person solely owns at least one open item: if they are away, nobody is named to pick it up. */
  bus_factor_1: boolean;
  /** The projects (id) in which they solely own an open item. */
  sole_projects: string[];
};

export type HandoverReport = {
  generated_for: { project_id: string | null };
  summary: {
    projects: number;
    open_items: number;
    without_backup: number;
    unowned: number;
    people_bus_factor_1: number;
    projects_with_gaps: number;
  };
  projects: ProjectHandover[];
  key_people: KeyPerson[];
};

export type HandoverInput = {
  projects: ProjectRow[];
  risks: RiskRow[];
  issues: IssueRow[];
  tasks: TaskRow[];
  profiles: ProfileRow[];
  members: MemberRow[];
};

const isOpenProject = (p: ProjectRow) => p.rag_status !== "complete" && isOpenStatus(p.rag_status);
const isOpenRisk = (r: RiskRow) => isOpenStatus(r.status);
const isOpenIssue = (i: IssueRow) => isOpenStatus(i.status);
const isOpenTask = (t: TaskRow) => isOpenStatus(t.status_type, t.status);

type Slot = { item: HandoverItem; projectId: string; owner: PersonRef | null; backup: PersonRef | null };
type PersonAcc = { person: PersonRef; sole: number; backup: number; touched: Set<string>; soleProjects: Set<string> };

export function buildHandover(input: HandoverInput, projectId: string | null = null): HandoverReport {
  const profiles = new Map(input.profiles.map((p) => [p.id, p]));
  const members = new Map(input.members.map((m) => [m.id, m]));

  const profilePerson = (id: string): PersonRef => {
    const p = profiles.get(id);
    return { key: `p:${id}`, kind: "profile", id, label: p?.display_name?.trim() || p?.email || "Unknown person" };
  };
  const memberPerson = (id: string): PersonRef => {
    const m = members.get(id);
    if (m?.profile_id) return profilePerson(m.profile_id);
    return { key: `m:${id}`, kind: "resource_member", id, label: m?.name || "Unknown person" };
  };

  const slots: Slot[] = [];
  const projectIds = new Set(input.projects.map((p) => p.id));

  for (const p of input.projects) {
    if (!isOpenProject(p)) continue;
    slots.push({
      item: { type: "project", id: p.id, reference: p.code, title: p.name, status: p.rag_status },
      projectId: p.id,
      owner: p.owner_id ? profilePerson(p.owner_id) : null,
      backup: p.backup_owner_id ? profilePerson(p.backup_owner_id) : null,
    });
  }
  const registers: Array<[RiskRow[], ItemType, (r: RiskRow) => boolean]> = [
    [input.risks, "risk", isOpenRisk],
    [input.issues, "issue", isOpenIssue],
  ];
  for (const [list, type, open] of registers) {
    for (const r of list) {
      if (!open(r) || !projectIds.has(r.project_id)) continue;
      slots.push({
        item: { type, id: r.id, reference: r.reference_id, title: r.title, status: r.status },
        projectId: r.project_id,
        owner: r.owner_id ? profilePerson(r.owner_id) : null,
        backup: r.backup_owner_id ? profilePerson(r.backup_owner_id) : null,
      });
    }
  }
  for (const t of input.tasks) {
    if (!isOpenTask(t) || !projectIds.has(t.project_id)) continue;
    slots.push({
      item: { type: "task", id: t.id, reference: null, title: t.name, status: t.status },
      projectId: t.project_id,
      owner: t.assignee_id ? memberPerson(t.assignee_id) : null,
      backup: t.backup_assignee_id ? memberPerson(t.backup_assignee_id) : null,
    });
  }

  // Per project: items with an owner and no backup, grouped by owner; plus unowned items.
  const perProject = new Map<string, ProjectHandover>();
  for (const p of input.projects) {
    perProject.set(p.id, {
      project: { id: p.id, code: p.code, name: p.name },
      open_items: 0, without_backup: 0, unowned: 0, owners: [], unowned_items: [],
    });
  }
  const groups = new Map<string, Map<string, OwnerGroup>>();
  const people = new Map<string, PersonAcc>();
  const personEntry = (person: PersonRef): PersonAcc => {
    let e = people.get(person.key);
    if (!e) {
      e = { person, sole: 0, backup: 0, touched: new Set(), soleProjects: new Set() };
      people.set(person.key, e);
    }
    return e;
  };

  for (const s of slots) {
    const ph = perProject.get(s.projectId);
    if (!ph) continue;
    ph.open_items += 1;
    if (s.owner) personEntry(s.owner).touched.add(s.projectId);
    if (s.backup) {
      const e = personEntry(s.backup);
      e.backup += 1;
      e.touched.add(s.projectId);
    }
    if (!s.owner) {
      ph.unowned += 1;
      ph.unowned_items.push(s.item);
      continue;
    }
    if (s.backup) continue;
    ph.without_backup += 1;
    const e = personEntry(s.owner);
    e.sole += 1;
    e.soleProjects.add(s.projectId);
    let byOwner = groups.get(s.projectId);
    if (!byOwner) groups.set(s.projectId, (byOwner = new Map()));
    let g = byOwner.get(s.owner.key);
    if (!g) {
      g = { person: s.owner, counts: { project: 0, risk: 0, issue: 0, task: 0, total: 0 }, items: [] };
      byOwner.set(s.owner.key, g);
    }
    g.counts[s.item.type] += 1;
    g.counts.total += 1;
    g.items.push(s.item);
  }

  for (const [pid, byOwner] of groups) {
    perProject.get(pid)!.owners = [...byOwner.values()].sort(
      (a, b) => b.counts.total - a.counts.total || a.person.label.localeCompare(b.person.label),
    );
  }

  const projects = [...perProject.values()]
    .filter((p) => p.open_items > 0 || projectId !== null)
    .sort(
      (a, b) =>
        b.without_backup + b.unowned - (a.without_backup + a.unowned) ||
        (a.project.code ?? a.project.name).localeCompare(b.project.code ?? b.project.name),
    );

  const keyPeople: KeyPerson[] = [...people.values()]
    .map((e) => ({
      person: e.person,
      sole_items: e.sole,
      projects_touched: e.touched.size,
      backup_items: e.backup,
      bus_factor_1: e.sole > 0,
      sole_projects: [...e.soleProjects],
    }))
    .sort((a, b) => b.sole_items - a.sole_items || a.person.label.localeCompare(b.person.label));

  return {
    generated_for: { project_id: projectId },
    summary: {
      projects: projects.length,
      open_items: projects.reduce((n, p) => n + p.open_items, 0),
      without_backup: projects.reduce((n, p) => n + p.without_backup, 0),
      unowned: projects.reduce((n, p) => n + p.unowned, 0),
      people_bus_factor_1: keyPeople.filter((k) => k.bus_factor_1).length,
      projects_with_gaps: projects.filter((p) => p.without_backup + p.unowned > 0).length,
    },
    projects,
    key_people: keyPeople,
  };
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export const HANDOVER_CSV_COLUMNS = [
  "section", "project_code", "project_name", "item_type", "item_reference", "item_title", "item_status",
  "person", "person_id", "sole_items", "projects_touched", "backup_items", "bus_factor_1",
] as const;

/**
 * One flat table. `item` rows are open items with an owner and no backup, `unowned`
 * rows are open items nobody owns, `person` rows are the key-person matrix.
 */
export function handoverCsvRows(report: HandoverReport): unknown[][] {
  const rows: unknown[][] = [];
  for (const p of report.projects) {
    for (const g of p.owners) {
      for (const it of g.items) {
        rows.push(["item", p.project.code, p.project.name, it.type, it.reference, it.title, it.status,
          g.person.label, g.person.id, "", "", "", ""]);
      }
    }
    for (const it of p.unowned_items) {
      rows.push(["unowned", p.project.code, p.project.name, it.type, it.reference, it.title, it.status,
        "", "", "", "", "", ""]);
    }
  }
  for (const k of report.key_people) {
    rows.push(["person", "", "", "", "", "", "", k.person.label, k.person.id,
      k.sole_items, k.projects_touched, k.backup_items, k.bus_factor_1]);
  }
  return rows;
}

// ── Database read ─────────────────────────────────────────────────────────────

/** The slice of the Supabase client this module needs. */
export type HandoverDb = {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const PAGE = 1000;
const MAX_ROWS = 20_000;

async function fetchAll<T>(
  db: HandoverDb,
  table: string,
  columns: string,
  workspaceId: string | null,
  filters: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let q = db.from(table).select(columns);
    if (workspaceId !== null) q = q.eq("workspace_id", workspaceId);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q.order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`handover: ${table} read failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * `workspaceId` null means "trust the client": the console page reads with the signed-in
 * user's RLS-scoped client, which already limits every table to their workspace. The API
 * route always passes the actor's workspace.
 */
export async function gatherHandover(
  db: HandoverDb,
  workspaceId: string | null,
  projectId: string | null,
): Promise<HandoverReport> {
  const scope: Record<string, string> = projectId ? { id: projectId } : {};
  const child: Record<string, string> = projectId ? { project_id: projectId } : {};
  const [projects, risks, issues, tasks, profiles, members] = await Promise.all([
    fetchAll<ProjectRow>(db, "projects", "id, code, name, owner_id, backup_owner_id, rag_status", workspaceId, scope),
    fetchAll<RiskRow>(db, "risks", "id, project_id, reference_id, title, status, owner_id, backup_owner_id", workspaceId, child),
    fetchAll<IssueRow>(db, "issues", "id, project_id, reference_id, title, status, owner_id, backup_owner_id", workspaceId, child),
    fetchAll<TaskRow>(db, "tasks", "id, project_id, name, status, status_type, assignee_id, backup_assignee_id", workspaceId, child),
    fetchAll<ProfileRow>(db, "profiles", "id, display_name, email", workspaceId),
    fetchAll<MemberRow>(db, "resource_members", "id, name, profile_id", workspaceId),
  ]);
  return buildHandover({ projects, risks, issues, tasks, profiles, members }, projectId);
}
