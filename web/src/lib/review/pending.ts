/**
 * lib/review/pending.ts
 *
 * "What is waiting for me?" as data — the agent-facing twin of the console's
 * Review Queue (gather.ts). One read-only listing of every GOVERNED decision
 * that is waiting on a human, across the maker-checker families:
 *
 *   task_deletion / project_deletion / risk_deletion / issue_deletion / expense_deletion /
 *   document_deletion / milestone_deletion
 *                                      deletion_requests   status 'pending' (one kind per target_type, G8)
 *   change_request                     change_requests     status raised | under_review
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
 * (deletion: task:read | audit:read, change: change:read,
 * rebaseline: project:read), so this aggregate can never show a
 * token more than its individual endpoints would. Kinds the caller may not
 * read are reported in `hidden_kinds` (an empty list must not be mistaken for
 * "nothing is waiting"); a caller who can read none of them gets a 403.
 *
 * Assignment (G5): a request may name the approver it waits for
 * (assigned_approver_id, set on raise, always an admin or manager). Each item
 * says whether it is assigned to THIS caller (`assigned_to_me`, compared by
 * person like four-eyes) and `mine: true` narrows the queue to those. Assignment
 * is routing only: it never changes `can_decide`. A caller with no resolvable
 * person has nothing assigned to them, so `mine` is an empty queue for them.
 *
 * Workspace isolation: token callers run on the admin client (RLS bypassed),
 * so EVERY query here filters `workspace_id`. A failing query throws (-> 500)
 * rather than counting as empty: an absent check must never look like a pass.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "@/lib/auth/guard";
import { ScopeError } from "@/lib/api/errors";
import { DELETION_KIND_BY_TARGET, deletionKindFor, isDeletionKind, targetTypeOfDeletionKind } from "@/lib/integrations/types";
import { describeChildCounts, type ChildCountLine } from "./deletion-target";
import {
  isRetroOverdue,
  loadApprovalPolicy,
  policyOf,
  roleMeetsTier,
  tierOf,
  tierRoleMessage,
  approverRoleFor,
} from "@/lib/governance/tiers";

export const PENDING_KINDS = [
  "task_deletion",
  "project_deletion",
  "risk_deletion",
  "issue_deletion",
  "expense_deletion",
  "document_deletion",
  "milestone_deletion",
  "change_request",
  "rebaseline",
] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];

export interface PendingItem {
  kind: PendingKind;
  id: string;
  title: string;
  /** One line of context (reason / status); null when there is none. */
  summary: string | null;
  project_id: string | null;
  project_name: string | null;
  requested_by_label: string | null;
  requested_at: string;
  can_decide: boolean;
  /** Why the caller cannot decide; null when `can_decide` is true. */
  reason_if_not: string | null;
  /** The approver this request was assigned to on raise (profile id); null = nobody in particular. */
  assigned_approver_id: string | null;
  /** True when it is assigned to the person behind the caller. */
  assigned_to_me: boolean;
  /**
   * Deletions only: what approving also removes or detaches, as the request recorded it (project: its
   * records; milestone: its tasks). Empty for a record with nothing under it, and for other kinds.
   */
  removes: Pick<ChildCountLine, "label" | "count" | "governed">[];
  /**
   * Approval-tier fields (wave 4). Null when the database has not got the column yet or the
   * request carries none: absent, never guessed.
   */
  tier: string | null;
  approval_deadline_at: string | null;
  retro_due_at: string | null;
  /** True for an emergency change still owed its retro approval. Computed, not stored. */
  retro_overdue: boolean | null;
  is_emergency: boolean;
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
  /** Only requests assigned to the person behind the caller (G5). */
  mine?: boolean;
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
  risk_deletion: ["risk:read", "audit:read"],
  issue_deletion: ["issue:read", "audit:read"],
  expense_deletion: ["budget:read", "audit:read"],
  document_deletion: ["document:read", "audit:read"],
  milestone_deletion: ["milestone:read", "audit:read"],
  change_request: ["change:read"],
  rebaseline: ["project:read"],
};

/** The checker scope the matching decision route demands. */
export const DECIDE_SCOPES: Readonly<Record<PendingKind, string>> = {
  task_deletion: "task:delete:approve",
  project_deletion: "project:delete:approve",
  risk_deletion: "risk:delete:approve",
  issue_deletion: "issue:delete:approve",
  expense_deletion: "expense:delete:approve",
  document_deletion: "document:delete:approve",
  milestone_deletion: "milestone:delete:approve",
  change_request: "change:decide",
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
  return Object.prototype.hasOwnProperty.call(DELETION_KIND_BY_TARGET, String(row.target_type))
    ? deletionKindFor(String(row.target_type))
    : null;
}

/** Who raised the request, as the row records it (no lookups). */
export function requesterOf(c: Pick<Candidate, "kind" | "row">): Requester {
  const r = c.row;
  // The principal columns (principal-aware four-eyes migration) may or may not
  // exist yet on this database: use them when present, else the caller falls
  // back to a user id / token-owner lookup.
  const explicit: string | null =
    (typeof r.requested_principal_id === "string" && r.requested_principal_id) ||
    null;
  if (isDeletionKind(c.kind)) {
    return { type: r.requested_by_type ?? null, id: r.requested_by_id ?? null, principal: explicit };
  }
  switch (c.kind) {
    case "change_request": {
      // Pre-0043 rows carry only the profile-id `requested_by`.
      const type = r.requested_by_type ?? (r.requested_by ? "user" : null);
      return { type, id: r.requested_by_id ?? r.requested_by ?? null, principal: explicit };
    }
    case "rebaseline":
      // Token-raised rebaselines record no requester id (requested_by is user-only).
      return { type: r.requested_by ? "user" : null, id: r.requested_by ?? null, principal: explicit };
  }
}

function projectIdOf(c: Candidate): string | null {
  const r = c.row;
  if (c.kind === "project_deletion") return typeof r.target_id === "string" ? r.target_id : null;
  if (isDeletionKind(c.kind)) return typeof r.before?.project_id === "string" ? r.before.project_id : null;
  switch (c.kind) {
    case "change_request":
    case "rebaseline":
      return typeof r.project_id === "string" ? r.project_id : null;
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
  actor: Pick<Actor, "type" | "id" | "workspaceId" | "principalId"> & { role?: string | null; principalRole?: string | null },
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
    const needed = [...new Set(Object.values(READ_SCOPES).flat())].join(", ");
    throw new ScopeError(`API token is missing a read scope for approvals: needs one of ${needed}`);
  }
  const wanted = opts.kinds ? visible.filter((k) => opts.kinds!.includes(k)) : [...visible];
  if (opts.kinds && opts.kinds.length > 0 && wanted.length === 0) {
    // Asked for specific kinds and can read none of them: an empty page would
    // read as "nothing waiting", so refuse instead.
    const needed = [...new Set(opts.kinds.flatMap((k) => READ_SCOPES[k]))].join(", ");
    throw new ScopeError(`API token is missing a read scope for the requested approvals: needs one of ${needed}`);
  }

  const wantedDeletions = wanted.filter(isDeletionKind);
  const wantsDeletion = wantedDeletions.length > 0;
  const deletionTypes: string[] = wantedDeletions.map((k) => targetTypeOfDeletionKind(k));

  const actorPrincipal = resolveActorPrincipal(actor);
  // G5: "mine" = assigned to the person behind the caller. No person, nothing assigned.
  if (opts.mine && !actorPrincipal) return { items: [], total: 0, page, limit, hidden_kinds };
  const onlyMine = (q: any) => (opts.mine ? q.eq("assigned_approver_id", actorPrincipal) : q); // eslint-disable-line @typescript-eslint/no-explicit-any

  const [deletions, changes, rebaselines] = await Promise.all([
    wantsDeletion
      ? fetchSource(db, "deletion_requests", ws, "created_at", window, (q) =>
          onlyMine(q.eq("status", "pending").in("target_type", deletionTypes)),
        )
      : { rows: [], count: 0 },
    wanted.includes("change_request")
      ? fetchSource(db, "change_requests", ws, "raised_at", window, (q) =>
          // Waiting = raised, under review or emergency; or an implemented emergency change whose retro decision is owed.
          onlyMine(q.or("status.in.(raised,under_review,emergency),and(status.eq.implemented,is_emergency.eq.true,retro_decided_at.is.null)")),
        )
      : { rows: [], count: 0 },
    wanted.includes("rebaseline")
      ? fetchSource(db, "rebaselines", ws, "created_at", window, (q) => onlyMine(q.eq("status", "pending_approval")))
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
  const requesters = slice.map((c) => requesterOf(c));
  const tokenIds = [
    ...new Set(
      requesters.filter((r) => r.type === "token" && !r.principal && r.id).map((r) => r.id as string),
    ),
  ];
  const profileIds = [
    ...new Set(slice.filter((c) => c.kind === "rebaseline" && c.row.requested_by).map((c) => c.row.requested_by)),
  ] as string[];

  const [projects, tokens, profiles] = await Promise.all([
    lookup(db, "projects", "id, name", ws, projectIds, false),
    lookup(db, "api_tokens", "id, created_by", ws, tokenIds, true),
    lookup(db, "profiles", "id, display_name, email", ws, profileIds, false),
  ]);
  const projectName = new Map(projects.map((p) => [p.id as string, p.name as string]));
  const tokenOwner = new Map(tokens.map((t) => [t.id as string, (t.created_by as string | null) ?? null]));
  const profileLabel = new Map(
    profiles.map((p) => [p.id as string, (p.display_name || p.email || null) as string | null]),
  );

  // Who may decide which tier (W4-A): the workspace policy, and the role of the human behind the caller.
  // A caller whose role is not known here is left to the decision route, which re-checks.
  const now = new Date();
  const actorRole = actor.type === "user" ? actor.role : actor.principalRole;
  const policy = actorRole === undefined ? policyOf({}) : await loadApprovalPolicy(db as never, ws);

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
    let verdict = evaluateDecision({
      actor,
      actorPrincipal,
      requester,
      scopeProblem: scopeProblem(c.kind),
    });
    if (verdict.can_decide && actorRole !== undefined) {
      const rowTier = r.is_emergency === true ? "emergency" : tierOf(r);
      if (!roleMeetsTier(actorRole, rowTier, policy)) {
        verdict = { can_decide: false, reason_if_not: tierRoleMessage(approverRoleFor(rowTier, policy)) };
      }
    }

    let title: string;
    let summary: string | null = null;
    let label: string | null = null;
    switch (c.kind) {
      case "task_deletion":
      case "project_deletion":
      case "risk_deletion":
      case "issue_deletion":
      case "expense_deletion":
      case "document_deletion":
      case "milestone_deletion": {
        const type = targetTypeOfDeletionKind(c.kind);
        const name =
          clip(r.before?.name ?? r.before?.title ?? r.before?.description, 120) ??
          (type === "project" ? projectName.get(r.target_id) : undefined) ??
          r.target_id;
        title = `Delete ${type}: ${name}`;
        summary = clip(r.reason, 240);
        label = r.requested_by_label ?? null;
        break;
      }
      case "change_request":
        title = `Change request${r.reference_id ? ` ${r.reference_id}` : ""}: ${clip(r.title, 120) ?? "(untitled)"}`;
        summary = [r.status, r.category, r.priority ? `${r.priority} priority` : null].filter(Boolean).join(" · ") || null;
        label = r.requested_by_label ?? null;
        break;
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
      assigned_approver_id: typeof r.assigned_approver_id === "string" ? r.assigned_approver_id : null,
      assigned_to_me: !!actorPrincipal && r.assigned_approver_id === actorPrincipal,
      removes: isDeletionKind(c.kind)
        ? describeChildCounts(r.before, targetTypeOfDeletionKind(c.kind)).map(({ label: what, count, governed }) => ({
            label: what,
            count,
            governed,
          }))
        : [],
      tier: r.is_emergency === true ? "emergency" : typeof r.tier === "string" && r.tier ? r.tier : null,
      approval_deadline_at: typeof r.approval_deadline_at === "string" ? r.approval_deadline_at : null,
      retro_due_at: typeof r.retro_due_at === "string" ? r.retro_due_at : null,
      retro_overdue: c.kind === "change_request" ? isRetroOverdue(r, now) : null,
      is_emergency: r.is_emergency === true,
    };
  });

  const total = deletions.count + changes.count + rebaselines.count;
  return { items, total, page, limit, hidden_kinds };
}
