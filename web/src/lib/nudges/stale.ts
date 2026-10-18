import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit, systemActor } from "@/lib/audit/write";
import { notifyEach, type NotifyEachInput } from "@/lib/notify/publish";
import { entityHref } from "@/lib/nav/entity-href";
import { getWorkspaceTimeZone, todayInZone } from "@/lib/integrations/time-zone";
import { getNudgeSettings } from "@/lib/nudges/settings";
import { sanitizeError } from "@/lib/integrations/secrets";
import { isOpenStatus } from "@/lib/work/open";

/**
 * Stale-item nudges (R-141, audit item A4).
 *
 * A task, risk or issue is STALE when it is still open (the shared definition
 * in lib/work/open.ts) and its last AUDITED change is at least
 * `workspaces.stale_days` days old: an item with an audit row newer than that
 * is not stale; an item never changed since it was created counts from its
 * last update. The weekly digest and report use this same rule. The kanban
 * card flag is the one place that still measures time in the CURRENT STATUS
 * (its age is merged by the project page).
 *
 * The daily cron step raises one in-app notification per stale item to its
 * assignee/owner (the project owner when it has none), at most once per item
 * per workspace day (`nudge_log` unique index), and writes ONE `nudge.sent`
 * audit row per batch AFTER the notifications went out, with the real count.
 *
 * Re-nudge cadence: the once-per-day ceiling is the schema rule, but nagging
 * the same item every day would train people to ignore the bell, so an item
 * that was nudged in the last NUDGE_COOLDOWN_DAYS is skipped.
 */

export const NUDGE_COOLDOWN_DAYS = 7;
/** Most items one workspace nudges per run (stalest first); the rest wait for the next tick. */
export const MAX_NUDGES_PER_RUN = 200;
/** Most items one list query reads. */
const SCAN_LIMIT = 500;
/** Ids per `.in()` lookup (they travel in the URL). */
const CHUNK = 100;
/** Smaller chunk for the audit lookup, so one busy item cannot crowd the page cap. */
const AUDIT_CHUNK = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StaleKind = "task" | "risk" | "issue";

export type StaleItem = {
  kind: StaleKind;
  id: string;
  title: string;
  projectId: string;
  projectCode: string | null;
  projectName: string | null;
  /**
   * Profile to tell: a task's assignee (resolved through resource_members.profile_id) or a
   * risk/issue owner; the project owner when nobody is assigned. Null = nobody to tell
   * (assigned to a resource member with no login).
   */
  recipientId: string | null;
  updatedAt: string;
  daysStale: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
type Row = Record<string, unknown>;

/** Whole days since `updatedAt`, never negative. */
export function daysSince(updatedAt: string, now: Date): number {
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : 0;
}

/** Stale = no change for at least `staleDays` whole days. */
export function isStaleSince(updatedAt: string, now: Date, staleDays: number): boolean {
  return daysSince(updatedAt, now) >= staleDays;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Open tasks, risks and issues whose last audited change is `staleDays` or more old,
 * stalest first. Workspace-filtered. Three list queries, then batched lookups for audit
 * rows, resource members and projects; never one query per item.
 */
export async function findStaleItems(
  db: Db,
  workspaceId: string,
  staleDays: number,
  now: Date,
): Promise<StaleItem[]> {
  const cutoff = new Date(now.getTime() - staleDays * DAY_MS).toISOString();
  const base = (table: string, cols: string) =>
    db
      .from(table)
      .select(cols)
      .eq("workspace_id", workspaceId)
      .lte("updated_at", cutoff)
      .order("updated_at", { ascending: true })
      .limit(SCAN_LIMIT);

  // The database drops only the finished enum values; isOpenStatus applies the shared rule.
  const [tasks, risks, issues] = await Promise.all([
    base("tasks", "id, name, project_id, assignee_id, updated_at, status, status_type").not("status_type", "in", "(completed,canceled)"),
    base("risks", "id, title, project_id, owner_id, updated_at, status").not("status", "in", "(closed)"),
    base("issues", "id, title, project_id, owner_id, updated_at, status").not("status", "in", "(resolved,closed)"),
  ]);
  for (const r of [tasks, risks, issues]) if (r.error) throw r.error;

  let raw: Array<{ kind: StaleKind; row: Row; title: string; person: unknown }> = [
    ...((tasks.data ?? []) as Row[])
      .filter((row) => isOpenStatus(row.status_type as string, row.status as string))
      .map((row) => ({ kind: "task" as const, row, title: String(row.name ?? ""), person: row.assignee_id })),
    ...((risks.data ?? []) as Row[])
      .filter((row) => isOpenStatus(row.status as string))
      .map((row) => ({ kind: "risk" as const, row, title: String(row.title ?? ""), person: row.owner_id })),
    ...((issues.data ?? []) as Row[])
      .filter((row) => isOpenStatus(row.status as string))
      .map((row) => ({ kind: "issue" as const, row, title: String(row.title ?? ""), person: row.owner_id })),
  ];
  if (raw.length === 0) return [];

  // Anything with an audit row at or after the cutoff was changed recently: not stale.
  const touched = new Set<string>();
  for (const kind of ["task", "risk", "issue"] as const) {
    const ids = raw.filter((r) => r.kind === kind).map((r) => String(r.row.id));
    for (const part of chunks(ids, AUDIT_CHUNK)) {
      const { data, error } = await db
        .from("audit_log")
        .select("target_id")
        .eq("workspace_id", workspaceId)
        .eq("target_type", kind)
        .gte("created_at", cutoff)
        .in("target_id", part);
      if (error) throw error;
      for (const a of (data ?? []) as Row[]) touched.add(`${kind}:${a.target_id}`);
    }
  }
  raw = raw.filter((r) => !touched.has(`${r.kind}:${r.row.id}`));
  if (raw.length === 0) return [];

  // A task's assignee is a resource member; the person to tell is that member's login.
  const memberIds = [...new Set(raw.filter((r) => r.kind === "task" && typeof r.person === "string" && r.person).map((r) => String(r.person)))];
  const memberProfile = new Map<string, string | null>();
  for (const part of chunks(memberIds, CHUNK)) {
    const { data, error } = await db
      .from("resource_members")
      .select("id, profile_id")
      .eq("workspace_id", workspaceId)
      .in("id", part);
    if (error) throw error;
    for (const m of (data ?? []) as Row[]) memberProfile.set(String(m.id), (m.profile_id as string | null) ?? null);
  }

  const projectIds = [...new Set(raw.map((r) => String(r.row.project_id)))];
  const projects = new Map<string, { code: string | null; name: string | null; owner: string | null; done: boolean }>();
  for (const part of chunks(projectIds, CHUNK)) {
    const { data, error } = await db
      .from("projects")
      .select("id, code, name, owner_id, rag_status")
      .eq("workspace_id", workspaceId)
      .in("id", part);
    if (error) throw error;
    for (const p of (data ?? []) as Row[]) {
      projects.set(String(p.id), {
        code: (p.code as string | null) ?? null,
        name: (p.name as string | null) ?? null,
        owner: (p.owner_id as string | null) ?? null,
        done: p.rag_status === "complete",
      });
    }
  }

  return raw
    .filter((r) => {
      const p = projects.get(String(r.row.project_id));
      return p !== undefined && !p.done; // a finished project is not "stale", and an unknown one is not ours
    })
    .map((r): StaleItem => {
      const p = projects.get(String(r.row.project_id))!;
      const updatedAt = String(r.row.updated_at);
      const assigned = typeof r.person === "string" && r.person ? r.person : null;
      let recipientId: string | null;
      if (!assigned) recipientId = p.owner;
      else if (r.kind === "task") recipientId = memberProfile.get(assigned) ?? null; // no login: nobody to tell
      else recipientId = assigned;
      return {
        kind: r.kind,
        id: String(r.row.id),
        title: r.title,
        projectId: String(r.row.project_id),
        projectCode: p.code,
        projectName: p.name,
        recipientId,
        updatedAt,
        daysStale: daysSince(updatedAt, now),
      };
    })
    .sort((a, b) => b.daysStale - a.daysStale);
}

/** How many open items are stale right now (the Lark digest's "Stale items" line). Fail-soft. */
export async function countStaleItems(
  workspaceId: string,
  staleDays: number,
  now: Date = new Date(),
): Promise<number> {
  try {
    return (await findStaleItems(createAdminClient(), workspaceId, staleDays, now)).length;
  } catch (err) {
    console.error("[nudges] stale count failed:", sanitizeError(err));
    return 0;
  }
}

export type StaleRunResult =
  | { status: "disabled" | "nothing_stale" }
  | { status: "failed" }
  | { status: "sent"; stale: number; sent: number; unassigned: number; truncated: number };

const kindLabel: Record<StaleKind, string> = { task: "task", risk: "risk", issue: "issue" };

/**
 * One workspace's stale-nudge pass. Idempotent: the same workspace day never
 * notifies an item twice (select-then-claim, with the unique index as the
 * backstop for a racing tick).
 */
export async function runStaleNudges(workspaceId: string, now: Date = new Date()): Promise<StaleRunResult> {
  const db: Db = createAdminClient();
  const settings = await getNudgeSettings(workspaceId);
  if (!settings.nudges_enabled) return { status: "disabled" };

  let items: StaleItem[];
  try {
    items = await findStaleItems(db, workspaceId, settings.stale_days, now);
  } catch (err) {
    console.error("[nudges] stale scan failed:", sanitizeError(err));
    return { status: "failed" };
  }
  if (items.length === 0) return { status: "nothing_stale" };

  const timeZone = await getWorkspaceTimeZone(workspaceId);
  const today = todayInZone(timeZone, now);
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - (NUDGE_COOLDOWN_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);

  // Only people who are (still) members of THIS workspace can be told; a removed or foreign id is
  // treated as "nobody to tell" so it never takes a ledger slot or an audit count.
  const members = new Set<string>();
  try {
    const recipientIds = [...new Set(items.map((i) => i.recipientId).filter((v): v is string => !!v))];
    for (const part of chunks(recipientIds, CHUNK)) {
      const { data, error } = await db.from("profiles").select("id").eq("workspace_id", workspaceId).in("id", part);
      if (error) throw error;
      for (const p of (data ?? []) as Row[]) members.add(String(p.id));
    }
  } catch (err) {
    console.error("[nudges] member lookup failed:", sanitizeError(err));
    return { status: "failed" };
  }
  const unassigned = items.filter((i) => !i.recipientId || !members.has(i.recipientId)).length;
  let candidates = items.filter((i) => i.recipientId && members.has(i.recipientId));

  // Already nudged inside the cooldown window (this includes earlier today).
  const recent = new Set<string>();
  try {
    for (const part of chunks(candidates.map((i) => i.id), CHUNK)) {
      const { data, error } = await db
        .from("nudge_log")
        .select("target_id, recipient_id")
        .eq("workspace_id", workspaceId)
        .eq("kind", "stale")
        .gte("sent_on", since)
        .in("target_id", part);
      if (error) throw error;
      for (const r of (data ?? []) as Row[]) recent.add(`${r.target_id}:${r.recipient_id}`);
    }
  } catch (err) {
    console.error("[nudges] nudge_log read failed:", sanitizeError(err));
    return { status: "failed" };
  }
  candidates = candidates.filter((i) => !recent.has(`${i.id}:${i.recipientId}`));
  if (candidates.length === 0) return { status: "nothing_stale" };

  const truncated = Math.max(0, candidates.length - MAX_NUDGES_PER_RUN);
  const batch = candidates.slice(0, MAX_NUDGES_PER_RUN);

  // Claim first: whoever inserts the ledger row owns the notification.
  const logRows: LogRow[] = batch.map((i) => ({
    workspace_id: workspaceId,
    target_type: i.kind,
    target_id: i.id,
    kind: "stale",
    recipient_id: i.recipientId,
    sent_on: today,
  }));
  const claimed = await claimRows(db, workspaceId, logRows);
  if (claimed.length === 0) return { status: "nothing_stale" };
  const claimedKeys = new Set(claimed.map((r) => `${r.target_id}:${r.recipient_id}`));
  const sending = batch.filter((i) => claimedKeys.has(`${i.id}:${i.recipientId}`));

  const messages: NotifyEachInput[] = sending.map((i) => ({
    recipientId: i.recipientId!,
    type: "item.stale",
    title: `Stale ${kindLabel[i.kind]}: ${i.title}`.slice(0, 200),
    body: `No change for ${i.daysStale} days${i.projectCode ? ` in ${i.projectCode}` : ""}. Update it, or close it if it is done.`,
    payload: { href: entityHref(i.kind, { id: i.id, projectId: i.projectId }), kind: i.kind, target_id: i.id, days: i.daysStale },
  }));
  const sent = await notifyEach(workspaceId, messages);
  if (sent === 0) {
    // Nobody was told: free the claim so the next tick retries, and write no audit row.
    await releaseClaim(db, workspaceId, sending, today);
    return { status: "failed" };
  }

  // One audit row for the batch, with what actually went out.
  try {
    await writeAudit({
      workspaceId,
      actor: systemActor(workspaceId, "nudge", { channel: "api" }),
      action: "nudge.sent",
      targetType: "workspace",
      targetId: workspaceId,
      after: {
        kind: "stale",
        stale_days: settings.stale_days,
        count: sent,
        ids: sending.map((i) => i.id),
      },
    });
  } catch (err) {
    // The notifications cannot be recalled; say so loudly so the gap is visible in the logs.
    console.error("[nudges] nudge.sent audit write failed AFTER notifying:", sanitizeError(err));
  }
  return { status: "sent", stale: items.length, sent, unassigned, truncated };
}

type LogRow = {
  workspace_id: string;
  target_type: string;
  target_id: string;
  kind: string;
  recipient_id: string | null;
  sent_on: string;
};

/** Insert ledger rows; on a unique-violation race fall back to one-by-one so only the losers drop out. */
async function claimRows(db: Db, workspaceId: string, rows: LogRow[]): Promise<LogRow[]> {
  const bulk = await db.from("nudge_log").insert(rows.map((r) => ({ ...r, workspace_id: workspaceId })));
  if (!bulk.error) return rows;
  const won: LogRow[] = [];
  for (const row of rows) {
    const one = await db.from("nudge_log").insert({ ...row, workspace_id: workspaceId });
    if (!one.error) won.push(row);
    else if ((one.error as { code?: string }).code !== "23505") {
      console.error("[nudges] nudge_log insert failed:", sanitizeError(one.error));
    }
  }
  return won;
}

async function releaseClaim(db: Db, workspaceId: string, items: StaleItem[], day: string): Promise<void> {
  try {
    for (const part of chunks(items.map((i) => i.id), CHUNK)) {
      await db.from("nudge_log").delete().eq("workspace_id", workspaceId).eq("kind", "stale").eq("sent_on", day).in("target_id", part);
    }
  } catch (err) {
    console.error("[nudges] could not release the claim:", sanitizeError(err));
  }
}
