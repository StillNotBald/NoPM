/**
 * lib/review/pending.ts
 *
 * "What is waiting for me?" as data — the agent-facing twin of the console's
 * Review Queue (gather.ts). One read-only listing of every GOVERNED decision
 * that is waiting on a human, across the four maker-checker families:
 *
 *   task_deletion / project_deletion   deletion_requests   status 'pending'
 *   change_request                     change_requests     status raised | under_review
 *   timesheet                          timesheet_submissions status 'submitted'
 *   rebaseline                         rebaselines         status 'pending_approval'
 *
 * (risks / clashes / documents are review-queue FYIs, not governed decisions,
 * so they are deliberately not here.) The kind strings for the first four
 * match `ApprovalKind` in @/lib/integrations/types so a caller can hand
 * `{ kind, id }` straight to the governed decision path.
 *
 * Each item says whether THIS caller may decide it (`can_decide`) and, when
 * not, why (`reason_if_not`). Items the caller raised are still listed — an
 * agent asked "what is waiting?" should see its own request sitting there,
 * just flagged as one it cannot decide. Four-eyes compares PEOPLE
 * (Actor.principalId), mirroring the decision routes:
 *   - missing decide scope                      -> cannot decide
 *   - caller has no resolvable principal        -> cannot decide (fail-closed)
 *   - caller IS the requester (same actor)      -> cannot decide
 *   - caller's principal == requester's principal (e.g. a token the same
 *     person created)                           -> cannot decide
 * `can_decide` is advisory — the decision routes re-check everything — but it
 * is computed from the same inputs so it rarely disagrees.
 *
 * Read gating is per kind and mirrors each family's own list endpoint
 * (deletion: task:read | audit:read, change: change:read, timesheet:
 * time:read, rebaseline: project:read), so this aggregate can never show a
 * token more than its individual endpoints would. Kinds the caller may not
 * read are reported in `hidden_kinds` (an empty list must not be mistaken for
 * "nothing is waiting"); a caller who can read none of them gets a 403.
 *
 * Workspace isolation: token callers run on the admin client (RLS bypassed),
 * so EVERY query here filters `workspace_id`. A failing query throws (-> 500)
 * rather than counting as empty: an absent check must never look like a pass.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "@/lib/auth/guard";
import { ScopeError } from "@/lib/api/errors";

export const PENDING_KINDS = [
  "task_deletion",
  "project_deletion",
  "change_request",
  "timesheet",
  "rebaseline",
] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];

export interface PendingItem {
  kind: PendingKind;
  id: string;
  title: string;
  /** One line of context (reason / status / hours); null when there is none. */
  summary: string | null;
  project_id: string | null;
  project_name: string | null;
  requested_by_label: string | null;
  requested_at: string;
  can_decide: boolean;
  /** Why the caller cannot decide; null when `can_decide` is true. */
  reason_if_not: string | null;
}

export interface PendingResult {
  items: PendingItem[];
  /** Exact number of pending items across the kinds the caller can read. */
  total: number;
  page: number;
  limit: number;
  /** Kinds omitted because the caller lacks their read scope. */
  hidden_kinds: PendingKind[];
}

export interface PendingOptions {
  page?: number;
  limit?: number;
  /** Restrict to these kinds (default: all). */
  kinds?: readonly PendingKind[];
}

/**
 * Scope probe injected by the caller (the route wraps `requireScope`): returns
 * null when the actor holds `scope`, else the human-readable reason. Injected
 * rather than re-implemented here so the wildcard / privileged-scope / viewer
 * rules stay in exactly one place (guard.ts + tokens.ts).
 */
export type ScopeProbe = (scope: string) => string | null;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
/** Rows fetched per kind to build the merged window (bounds deep paging). */
export const MAX_WINDOW = 1000;

/** Any ONE of these makes the kind visible — same gates as the kind's own list endpoint. */
export const READ_SCOPES: Readonly<Record<PendingKind, readonly string[]>> = {
  task_deletion: ["task:read", "audit:read"],
  project_deletion: ["task:read", "audit:read"],
  change_request: ["change:read"],
  timesheet: ["time:read"],
  rebaseline: ["project:read"],
};

/** The checker scope the matching decision route demands. */
export const DECIDE_SCOPES: Readonly<Record<PendingKind, string>> = {
  task_deletion: "task:delete:approve",
  project_deletion: "project:delete:approve",
  change_request: "change:decide",
  timesheet: "time:approve",
  rebaseline: "rebaseline:approve",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// ── pure helpers (exported for tests) ────────────────────────────────────────

/**
 * The human behind the caller. `Actor.principalId` is authoritative once the
 * guard sets it; when it is absent (older guard) fall back to the same rule:
 * a signed-in user is their own principal, a token has none we can prove.
 */
export function resolveActorPrincipal(actor: Pick<Actor, "type" | "id" | "principalId">): string | null {
  if (actor.principalId !== undefined) return actor.principalId;
  return actor.type === "user" ? actor.id : null;
}

/** Epoch ms of a timestamp string (0 when unparseable, so a bad row sorts first instead of throwing). */
function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Collapse whitespace and cap length so a long free-text field can't blow up a row/table. */
export function clip(value: unknown, max = 160): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface Requester {
  type: "user" | "token" | null;
  id: string | null;
  /** The requester's person, when the row (or a token-owner lookup) says. */
  principal: string | null;
}

export interface DecideVerdict {
  can_decide: boolean;
  reason_if_not: string | null;
}

/**
 * Can `actor` (whose person is `actorPrincipal`) decide an item raised by
 * `requester`, given `scopeProblem` (null = holds the decide scope)? Reasons
 * are ordered by what the caller can fix first: scope, then identity, then
 * four-eyes.
 */
export function evaluateDecision(input: {
  actor: Pick<Actor, "type" | "id">;
  actorPrincipal: string | null;
  requester: Requester;
  scopeProblem: string | null;
}): DecideVerdict {
  const { actor, actorPrincipal, requester, scopeProblem } = input;
  if (scopeProblem) return { can_decide: false, reason_if_not: scopeProblem };
  if (!actorPrincipal) {
    return {
      can_decide: false,
      reason_if_not:
        actor.type === "token"
          ? "This token has no recorded owner, so it cannot approve (four-eyes)"
          : "Your identity could not be resolved to a person, so you cannot approve (four-eyes)",
    };
  }
  if (requester.type && requester.id && requester.type === actor.type && requester.id === actor.id) {
    return { can_decide: false, reason_if_not: "You requested this; four-eyes requires a different person to decide" };
  }
  if (requester.principal && requester.principal === actorPrincipal) {
    return {
      can_decide: false,
      reason_if_not: "Raised by you (or by an agent acting for you); four-eyes requires a different person to decide",
    };
  }
  return { can_decide: true, reason_if_not: null };
}

// ── row mapping ──────────────────────────────────────────────────────────────

type Candidate = {
  kind: PendingKind;
  id: string;
  requested_at: string;
  row: Row;
};

function kindOfDeletion(row: Row): PendingKind | null {
  if (row.target_type === "task") return "task_deletion";
  if (row.target_type === "project") return "project_deletion";
  return null;
}

/** Who raised the request, as the row records it (no lookups). */
export function requesterOf(c: Pick<Candidate, "kind" | "row">): Requester {
  const r = c.row;
  // The principal columns (principal-aware four-eyes migration) may or may not
  // exist yet on this database: use them when present, else the caller falls
  // back to a user id / token-owner lookup.
  const explicit: string | null =
    (typeof r.requested_principal_id === "string" && r.requested_principal_id) ||
    (typeof r.submitted_principal_id === "string" && r.submitted_principal_id) ||
    null;
  switch (c.kind) {
    case "task_deletion":
    case "project_deletion":
      return { type: r.requested_by_type ?? null, id: r.requested_by_id ?? null, principal: explicit };
    case "change_request": {
      // Pre-0043 rows carry only the profile-id `requested_by`.
      const type = r.requested_by_type ?? (r.requested_by ? "user" : null);
      return { type, id: r.requested_by_id ?? r.requested_by ?? null, principal: explicit };
    }
    case "timesheet":
      return { type: r.submitted_by_type ?? null, id: r.submitted_by ?? null, principal: explicit };
    case "rebaseline":
      // Token-raised rebaselines record no requester id (requested_by is user-only).
      return { type: r.requested_by ? "user" : null, id: r.requested_by ?? null, principal: explicit };
  }
}

function projectIdOf(c: Candidate): string | null {
  const r = c.row;
  switch (c.kind) {
    case "task_deletion":
      return typeof r.before?.project_id === "string" ? r.before.project_id : null;
    case "project_deletion":
      return typeof r.target_id === "string" ? r.target_id : null;
    case "change_request":
    case "rebaseline":
      return typeof r.project_id === "string" ? r.project_id : null;
    case "timesheet":
      return null;
  }
}

// ── queries ──────────────────────────────────────────────────────────────────

async function fetchSource(
  db: SupabaseClient,
  table: string,
  workspaceId: string,
  orderCol: string,
  window: number,
  filter: (q: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<{ rows: Row[]; count: number }> {
  const base = db.from(table).select("*", { count: "exact" }).eq("workspace_id", workspaceId);
  const { data, count, error } = await filter(base).order(orderCol, { ascending: true }).limit(window);
  if (error) throw new Error(`review: ${table} query failed: ${error.message}`);
  return { rows: (data ?? []) as Row[], count: count ?? (data ?? []).length };
}

async function lookup(
  db: SupabaseClient,
  table: string,
  select: string,
  workspaceId: string,
  ids: string[],
  strict: boolean,
): Promise<Row[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from(table).select(select).eq("workspace_id", workspaceId).in("id", ids);
  if (error) {
    // Names are cosmetic (degrade to null); token owners decide can_decide (fail loud).
    if (strict) throw new Error(`review: ${table} lookup failed: ${error.message}`);
    return [];
  }
  return (data ?? []) as unknown as Row[];
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function listPendingApprovals(
  db: SupabaseClient,
  actor: Pick<Actor, "type" | "id" | "workspaceId" | "principalId">,
  checkScope: ScopeProbe,
  opts: PendingOptions = {},
): Promise<PendingResult> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const offset = (page - 1) * limit;
  const window = Math.min(offset + limit, MAX_WINDOW);
  const ws = actor.workspaceId;

  // Which kinds may this caller read at all?
  const visible = PENDING_KINDS.filter((k) => READ_SCOPES[k].some((s) => checkScope(s) === null));
  const hidden_kinds = PENDING_KINDS.filter((k) => !visible.includes(k));
  if (visible.length === 0) {
    throw new ScopeError(
      "API token is missing a read scope for approvals: needs one of task:read, audit:read, change:read, time:read, project:read",
    );
  }
  const wanted = opts.kinds ? visible.filter((k) => opts.kinds!.includes(k)) : [...visible];
  if (opts.kinds && opts.kinds.length > 0 && wanted.length === 0) {
    // Asked for specific kinds and can read none of them: an empty page would
    // read as "nothing waiting", so refuse instead.
    const needed = [...new Set(opts.kinds.flatMap((k) => READ_SCOPES[k]))].join(", ");
    throw new ScopeError(`API token is missing a read scope for the requested approvals: needs one of ${needed}`);
  }

  const wantsDeletion = wanted.some((k) => k === "task_deletion" || k === "project_deletion");
  const deletionTypes = [
    ...(wanted.includes("task_deletion") ? ["task"] : []),
    ...(wanted.includes("project_deletion") ? ["project"] : []),
  ];

  const [deletions, changes, timesheets, rebaselines] = await Promise.all([
    wantsDeletion
      ? fetchSource(db, "deletion_requests", ws, "created_at", window, (q) =>
          q.eq("status", "pending").in("target_type", deletionTypes),
        )
      : { rows: [], count: 0 },
    wanted.includes("change_request")
      ? fetchSource(db, "change_requests", ws, "raised_at", window, (q) => q.in("status", ["raised", "under_review"]))
      : { rows: [], count: 0 },
    wanted.includes("timesheet")
      ? fetchSource(db, "timesheet_submissions", ws, "submitted_at", window, (q) => q.eq("status", "submitted"))
      : { rows: [], count: 0 },
    wanted.includes("rebaseline")
      ? fetchSource(db, "rebaselines", ws, "created_at", window, (q) => q.eq("status", "pending_approval"))
      : { rows: [], count: 0 },
  ]);

  const candidates: Candidate[] = [];
  for (const row of deletions.rows) {
    const kind = kindOfDeletion(row);
    if (kind) candidates.push({ kind, id: row.id, requested_at: row.created_at, row });
  }
  for (const row of changes.rows) {
    candidates.push({ kind: "change_request", id: row.id, requested_at: row.raised_at ?? row.created_at, row });
  }
  for (const row of timesheets.rows) {
    candidates.push({ kind: "timesheet", id: row.id, requested_at: row.submitted_at, row });
  }
  for (const row of rebaselines.rows) {
    candidates.push({ kind: "rebaseline", id: row.id, requested_at: row.created_at, row });
  }

  // Oldest first (the longest-waiting decision is the most urgent); the tie-break
  // keeps paging deterministic when two requests share a timestamp.
  candidates.sort(
    (a, b) => time(a.requested_at) - time(b.requested_at) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
  );
  const slice = candidates.slice(offset, offset + limit);

  // Enrich the page (and only the page) with names and requester principals.
  const projectIds = [...new Set(slice.map(projectIdOf).filter((v): v is string => !!v))];
  const memberIds = [
    ...new Set(slice.filter((c) => c.kind === "timesheet").map((c) => c.row.member_id).filter(Boolean)),
  ] as string[];
  const requesters = slice.map((c) => requesterOf(c));
  const tokenIds = [
    ...new Set(
      requesters.filter((r) => r.type === "token" && !r.principal && r.id).map((r) => r.id as string),
    ),
  ];
  const profileIds = [
    ...new Set(slice.filter((c) => c.kind === "rebaseline" && c.row.requested_by).map((c) => c.row.requested_by)),
  ] as string[];

  const [projects, members, tokens, profiles] = await Promise.all([
    lookup(db, "projects", "id, name", ws, projectIds, false),
    lookup(db, "resource_members", "id, name", ws, memberIds, false),
    lookup(db, "api_tokens", "id, created_by", ws, tokenIds, true),
    lookup(db, "profiles", "id, display_name, email", ws, profileIds, false),
  ]);
  const projectName = new Map(projects.map((p) => [p.id as string, p.name as string]));
  const memberName = new Map(members.map((m) => [m.id as string, m.name as string]));
  const tokenOwner = new Map(tokens.map((t) => [t.id as string, (t.created_by as string | null) ?? null]));
  const profileLabel = new Map(
    profiles.map((p) => [p.id as string, (p.display_name || p.email || null) as string | null]),
  );

  const actorPrincipal = resolveActorPrincipal(actor);
  // Probe each decide scope once, not once per row.
  const scopeProblems = new Map<PendingKind, string | null>();
  const scopeProblem = (kind: PendingKind) => {
    if (!scopeProblems.has(kind)) scopeProblems.set(kind, checkScope(DECIDE_SCOPES[kind]));
    return scopeProblems.get(kind)!;
  };

  const items: PendingItem[] = slice.map((c, i) => {
    const r = c.row;
    const requester = requesters[i];
    if (!requester.principal) {
      requester.principal =
        requester.type === "user"
          ? requester.id
          : requester.type === "token" && requester.id
            ? (tokenOwner.get(requester.id) ?? null)
            : null;
    }
    const projectId = projectIdOf(c);
    const verdict = evaluateDecision({
      actor,
      actorPrincipal,
      requester,
      scopeProblem: scopeProblem(c.kind),
    });

    let title: string;
    let summary: string | null = null;
    let label: string | null = null;
    switch (c.kind) {
      case "task_deletion":
        title = `Delete task: ${clip(r.before?.name ?? r.before?.title, 120) ?? r.target_id}`;
        summary = clip(r.reason, 240);
        label = r.requested_by_label ?? null;
        break;
      case "project_deletion":
        title = `Delete project: ${clip(r.before?.name, 120) ?? projectName.get(r.target_id) ?? r.target_id}`;
        summary = clip(r.reason, 240);
        label = r.requested_by_label ?? null;
        break;
      case "change_request":
        title = `Change request${r.reference_id ? ` ${r.reference_id}` : ""}: ${clip(r.title, 120) ?? "(untitled)"}`;
        summary = [r.status, r.category, r.priority ? `${r.priority} priority` : null].filter(Boolean).join(" · ") || null;
        label = r.requested_by_label ?? null;
        break;
      case "timesheet": {
        const hours = Number(r.hours_total);
        title = `Timesheet: ${memberName.get(r.member_id) ?? "Unknown member"} · week of ${r.period_start}`;
        summary = Number.isFinite(hours)
          ? `${hours} h across ${r.entry_count ?? 0} ${r.entry_count === 1 ? "entry" : "entries"}`
          : null;
        label = r.submitted_by_label ?? null;
        break;
      }
      case "rebaseline":
        title = `Rebaseline v${r.version ?? 1} sign-off`;
        summary = clip(r.reason, 240);
        label = r.requested_by ? (profileLabel.get(r.requested_by) ?? null) : null;
        break;
    }

    return {
      kind: c.kind,
      id: c.id,
      title,
      summary,
      project_id: projectId,
      project_name: projectId
        ? (projectName.get(projectId) ?? (c.kind === "project_deletion" ? clip(r.before?.name, 120) : null))
        : null,
      requested_by_label: label,
      requested_at: c.requested_at,
      can_decide: verdict.can_decide,
      reason_if_not: verdict.reason_if_not,
    };
  });

  const total = deletions.count + changes.count + timesheets.count + rebaselines.count;
  return { items, total, page, limit, hidden_kinds };
}
