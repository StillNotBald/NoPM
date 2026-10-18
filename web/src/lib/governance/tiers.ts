/**
 * Approval tiers (audit gaps G1 G2 G3 G4 G7, change request assumptions A1 and A3).
 *
 * Five tiers decide WHO may approve a governed request and HOW LONG it may wait:
 *
 *   routine    -> manager   (the only tier that can be auto-approved, OFF by default)
 *   normal     -> manager
 *   high_risk  -> admin
 *   emergency  -> a flag, not an approval path (owner decision Q1, 2026-10-18): a manager or admin raises
 *                 it and it commits at once. Nobody decides it, no retro decision is owed.
 *   strategic  -> admin     (only an admin can ask for it)
 *
 * A cost threshold (default 50,000, compared as a plain number in the workspace's own currency) or a
 * schedule threshold (default 10 days) lifts a normal change request to high_risk. Every
 * default lives here and is overridden per workspace by `workspaces.approval_policy`
 * (migration 0100), which an admin edits in Settings. The same rules are repeated in the
 * database (nopm_tier_required_role, the tier triggers): this file gives the clean error,
 * the database is the backstop.
 *
 * Invariant kept from ADR 0014/0015: a SECOND HUMAN decides money and dates. The only way a
 * request is decided by no human is the routine auto-approve, which a workspace admin must
 * switch on, which never applies to a request carrying a cost or a schedule impact.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { FieldsError, ScopeError } from "@/lib/api/errors";

type Db = ReturnType<typeof createAdminClient>;

export const TIERS = ["routine", "normal", "high_risk", "emergency", "strategic"] as const;
export type Tier = (typeof TIERS)[number];
/** Tiers a requester may ask for. `emergency` is raised with `is_emergency`, never as a plain tier. */
export const REQUESTABLE_TIERS = ["routine", "normal", "high_risk", "strategic"] as const;
export type RequestableTier = (typeof REQUESTABLE_TIERS)[number];

export const APPROVER_ROLES = ["manager", "admin"] as const;
export type TierApproverRole = (typeof APPROVER_ROLES)[number];

export type TierRule = {
  /** The least role that may decide. An admin meets every tier; a manager meets the ones that say `manager`. */
  approver_role: TierApproverRole;
  /** Hours a decision may take; 0 = no turnaround timer. An emergency has none (it commits when raised). */
  turnaround_hours: number;
  /** Approve by policy when the turnaround passes with no decision. Routine only; OFF by default. */
  auto_approve: boolean;
};

export type ApprovalPolicy = {
  tiers: Record<Tier, TierRule>;
  /** A change request costing at least this much (either sign) is lifted from normal to high_risk. */
  currency_threshold: number;
  /**
   * A label only: the threshold and every cost are compared as plain numbers in the workspace's own
   * currency. It says which currency the threshold is stated in; it converts nothing.
   */
  currency: string | null;
  /** A schedule impact of more than this many days (either sign) lifts normal to high_risk. */
  schedule_threshold_days: number;
  /** DEPRECATED (owner decision Q1): read from old data, never used and never changed. An emergency owes no retro decision. */
  emergency_retro_hours: number;
};

export const DEFAULT_CURRENCY_THRESHOLD = 50_000;
export const DEFAULT_EMERGENCY_RETRO_HOURS = 48;
export const DEFAULT_SCHEDULE_THRESHOLD_DAYS = 10;
export const MAX_SCHEDULE_THRESHOLD_DAYS = 3650;
export const MAX_TURNAROUND_HOURS = 8760;
export const MAX_RETRO_HOURS = 720;

export const DEFAULT_POLICY: ApprovalPolicy = {
  tiers: {
    routine: { approver_role: "manager", turnaround_hours: 24, auto_approve: false },
    normal: { approver_role: "manager", turnaround_hours: 48, auto_approve: false },
    high_risk: { approver_role: "admin", turnaround_hours: 72, auto_approve: false },
    // Emergency: nobody decides it (Q1). The role is kept only so the policy shape stays the same.
    emergency: { approver_role: "admin", turnaround_hours: 0, auto_approve: false },
    strategic: { approver_role: "admin", turnaround_hours: 120, auto_approve: false },
  },
  currency_threshold: DEFAULT_CURRENCY_THRESHOLD,
  currency: "MYR",
  schedule_threshold_days: DEFAULT_SCHEDULE_THRESHOLD_DAYS,
  emergency_retro_hours: DEFAULT_EMERGENCY_RETRO_HOURS,
};

const TIER_RANK: Readonly<Record<Tier, number>> = { routine: 1, normal: 2, high_risk: 3, strategic: 4, emergency: 0 };

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

/** A stored tier, or `normal` for a legacy row / unknown value. */
export function tierOf(row: { tier?: unknown } | null | undefined): Tier {
  return isTier(row?.tier) ? row.tier : "normal";
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

// ── policy: resolve, validate ─────────────────────────────────────────────

/**
 * A stored `workspaces.approval_policy` (or null / partial / garbage) completed with the defaults.
 * Anything invalid falls back to its default, so a bad row can never lock approvals.
 */
export function policyOf(stored: unknown): ApprovalPolicy {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const rawTiers = (raw.tiers && typeof raw.tiers === "object" ? raw.tiers : {}) as Record<string, unknown>;
  const tiers = {} as Record<Tier, TierRule>;
  for (const t of TIERS) {
    const d = DEFAULT_POLICY.tiers[t];
    const r = (rawTiers[t] && typeof rawTiers[t] === "object" ? rawTiers[t] : {}) as Record<string, unknown>;
    tiers[t] = {
      approver_role: (APPROVER_ROLES as readonly unknown[]).includes(r.approver_role)
        ? (r.approver_role as TierApproverRole)
        : d.approver_role,
      turnaround_hours: isInt(r.turnaround_hours, 0, MAX_TURNAROUND_HOURS) ? r.turnaround_hours : d.turnaround_hours,
      // Auto-approve exists for routine only, whatever a hand-edited row says.
      auto_approve: t === "routine" && r.auto_approve === true,
    };
  }
  return {
    tiers,
    currency_threshold:
      typeof raw.currency_threshold === "number" && raw.currency_threshold >= 0
        ? raw.currency_threshold
        : DEFAULT_POLICY.currency_threshold,
    currency:
      raw.currency === null
        ? null
        : typeof raw.currency === "string" && raw.currency.length === 3
          ? raw.currency.toUpperCase()
          : DEFAULT_POLICY.currency,
    schedule_threshold_days: isInt(raw.schedule_threshold_days, 0, MAX_SCHEDULE_THRESHOLD_DAYS)
      ? raw.schedule_threshold_days
      : DEFAULT_SCHEDULE_THRESHOLD_DAYS,
    emergency_retro_hours: isInt(raw.emergency_retro_hours, 1, MAX_RETRO_HOURS)
      ? raw.emergency_retro_hours
      : DEFAULT_POLICY.emergency_retro_hours,
  };
}

export type PolicyIssue = { field: string; message: string };

/**
 * Validates a policy an admin submits (PATCH /api/workspace-settings). Returns the normalised
 * object to store: the FULL policy, every tier present, so what is stored is what is read.
 * Unknown keys, a non-routine auto_approve, a bad role and out-of-range numbers are rejected.
 */
export function validatePolicyInput(input: unknown): { ok: true; value: ApprovalPolicy } | { ok: false; issues: PolicyIssue[] } {
  const issues: PolicyIssue[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ field: "approval_policy", message: "Send an object." }] };
  }
  const p = input as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!["tiers", "currency_threshold", "currency", "emergency_retro_hours", "schedule_threshold_days"].includes(k)) {
      issues.push({ field: `approval_policy.${k}`, message: "Unknown setting." });
    }
  }
  const value = policyOf({});
  if (p.tiers !== undefined) {
    if (!p.tiers || typeof p.tiers !== "object" || Array.isArray(p.tiers)) {
      issues.push({ field: "approval_policy.tiers", message: "Send an object keyed by tier name." });
    } else {
      const given = p.tiers as Record<string, unknown>;
      for (const name of Object.keys(given)) {
        if (!isTier(name)) {
          issues.push({ field: `approval_policy.tiers.${name}`, message: `Tier must be one of ${TIERS.join(", ")}.` });
          continue;
        }
        const r = given[name];
        if (!r || typeof r !== "object" || Array.isArray(r)) {
          issues.push({ field: `approval_policy.tiers.${name}`, message: "Send an object." });
          continue;
        }
        const rule = r as Record<string, unknown>;
        for (const k of Object.keys(rule)) {
          if (!["approver_role", "turnaround_hours", "auto_approve"].includes(k)) {
            issues.push({ field: `approval_policy.tiers.${name}.${k}`, message: "Unknown setting." });
          }
        }
        if (rule.approver_role !== undefined) {
          if ((APPROVER_ROLES as readonly unknown[]).includes(rule.approver_role)) {
            value.tiers[name].approver_role = rule.approver_role as TierApproverRole;
          } else {
            issues.push({ field: `approval_policy.tiers.${name}.approver_role`, message: "Use manager or admin." });
          }
        }
        if (rule.turnaround_hours !== undefined) {
          if (isInt(rule.turnaround_hours, 0, MAX_TURNAROUND_HOURS)) value.tiers[name].turnaround_hours = rule.turnaround_hours;
          else {
            issues.push({
              field: `approval_policy.tiers.${name}.turnaround_hours`,
              message: `Use a whole number of hours from 0 to ${MAX_TURNAROUND_HOURS}.`,
            });
          }
        }
        if (rule.auto_approve !== undefined) {
          if (typeof rule.auto_approve !== "boolean") {
            issues.push({ field: `approval_policy.tiers.${name}.auto_approve`, message: "Use true or false." });
          } else if (rule.auto_approve && name !== "routine") {
            issues.push({
              field: `approval_policy.tiers.${name}.auto_approve`,
              message: "Only the routine tier can be approved automatically.",
            });
          } else {
            value.tiers[name].auto_approve = rule.auto_approve;
          }
        }
      }
      // Keep the values that were not sent: build on the stored shape, not just the defaults.
    }
  }
  if (p.currency_threshold !== undefined) {
    if (typeof p.currency_threshold === "number" && Number.isFinite(p.currency_threshold) && p.currency_threshold >= 0) {
      value.currency_threshold = p.currency_threshold;
    } else issues.push({ field: "approval_policy.currency_threshold", message: "Use a number of 0 or more." });
  }
  if (p.schedule_threshold_days !== undefined) {
    if (isInt(p.schedule_threshold_days, 0, MAX_SCHEDULE_THRESHOLD_DAYS)) value.schedule_threshold_days = p.schedule_threshold_days;
    else {
      issues.push({
        field: "approval_policy.schedule_threshold_days",
        message: `Use a whole number of days from 0 to ${MAX_SCHEDULE_THRESHOLD_DAYS}.`,
      });
    }
  }
  if (p.currency !== undefined && p.currency !== null) {
    if (typeof p.currency === "string" && /^[A-Za-z]{3}$/.test(p.currency)) value.currency = p.currency.toUpperCase();
    else issues.push({ field: "approval_policy.currency", message: "Use a three-letter currency code such as MYR." });
  }
  // `emergency_retro_hours` is deprecated (Q1): an old client may still send it. It is accepted, not validated and
  // not stored, so it can neither fail a save nor change anything.
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/**
 * Merge a validated PATCH onto the stored policy: only the rules the admin sent change, the
 * rest stay as stored. Returns the full normalised policy to write.
 */
export function mergePolicy(stored: unknown, patch: ApprovalPolicy, sent: unknown): ApprovalPolicy {
  const base = policyOf(stored);
  const s = (sent && typeof sent === "object" ? sent : {}) as Record<string, unknown>;
  const sentTiers = (s.tiers && typeof s.tiers === "object" ? s.tiers : {}) as Record<string, Record<string, unknown>>;
  const out: ApprovalPolicy = { ...base, tiers: { ...base.tiers } };
  for (const t of TIERS) {
    const rule = sentTiers[t];
    if (!rule) continue;
    out.tiers[t] = { ...base.tiers[t] };
    for (const k of ["approver_role", "turnaround_hours", "auto_approve"] as const) {
      if (rule[k] !== undefined) (out.tiers[t] as Record<string, unknown>)[k] = patch.tiers[t][k];
    }
  }
  if (s.currency_threshold !== undefined) out.currency_threshold = patch.currency_threshold;
  if (s.schedule_threshold_days !== undefined) out.schedule_threshold_days = patch.schedule_threshold_days;
  if (s.currency !== undefined) out.currency = s.currency === null ? null : patch.currency;
  return out;
}

/** The stored policy of a workspace; the defaults when the column does not exist yet (deploy before migrate). */
export async function loadApprovalPolicy(db: Db, workspaceId: string): Promise<ApprovalPolicy> {
  try {
    const { data, error } = await db.from("workspaces").select("approval_policy").eq("id", workspaceId).maybeSingle();
    if (error || !data) return policyOf({});
    return policyOf((data as { approval_policy?: unknown }).approval_policy);
  } catch {
    return policyOf({});
  }
}

// ── classification (G1, G7) ───────────────────────────────────────────────

export type ClassifyKind = "change_request" | "task_deletion" | "project_deletion" | "expense_deletion" | "rebaseline";

export type ClassifyInput = {
  kind: ClassifyKind;
  /** Signed cost impact in the request's currency; null / 0 = none. Change requests only. */
  impact_cost?: number | null;
  /** Schedule impact in days; a routine request may not carry one. Change requests only. */
  impact_schedule_days?: number | null;
  /** Amount of the expense being deleted, in the workspace's own currency. Expense deletions only. */
  amount?: number | null;
  /** Number of structured impact areas on the request; a routine request has none. */
  impact_scope_count?: number;
  is_emergency?: boolean;
  requested_tier?: RequestableTier | null;
  /** The role of the HUMAN raising it ('admin' | 'manager' | other). */
  requester_role?: string | null;
  policy: ApprovalPolicy;
};

export type Classification = {
  tier: Tier;
  /** Why the tier is not the one asked for / the plain default, in words an approver can read. */
  reason: string | null;
  /** True when the currency threshold lifted a normal request to high_risk. */
  threshold_bump: boolean;
};

const REQUESTER_ROLE_MESSAGE = "Only a manager or admin can raise an emergency change.";
const STRATEGIC_MESSAGE = "Only an admin can raise a strategic request.";

/**
 * The tier of a request being raised.
 *  - `is_emergency` -> emergency (only a manager or admin may; else 403 role_not_permitted).
 *  - `requested_tier: 'strategic'` -> strategic (admin only).
 *  - `requested_tier: 'routine'` -> routine, change requests only, and only with no cost and no
 *    schedule impact (else 422): a second human decides money and dates.
 *  - otherwise `normal`; a project deletion starts at high_risk (never lower), and so does an expense
 *    deletion whose amount reaches the cost threshold (owner decision Q5).
 *  - a normal change request with |cost| at or above the cost threshold, or a schedule impact of more
 *    than `schedule_threshold_days`, becomes high_risk (G7).
 * A requester may always ask for MORE scrutiny (high_risk), never less than the floor.
 */
export function classify(input: ClassifyInput): Classification {
  const { kind, policy } = input;
  const cost = Number(input.impact_cost ?? 0) || 0;
  const days = Number(input.impact_schedule_days ?? 0) || 0;
  const role = input.requester_role ?? null;

  if (input.is_emergency) {
    if (role !== "admin" && role !== "manager") throw new ScopeError(REQUESTER_ROLE_MESSAGE, "role_not_permitted");
    if (kind !== "change_request") {
      throw new FieldsError("Validation failed", [{ field: "is_emergency", message: "Only a change request can use the emergency path." }]);
    }
    return { tier: "emergency", reason: "Raised on the emergency path: flagged, committed at once, no approval required.", threshold_bump: false };
  }

  const asked = input.requested_tier ?? null;
  if (asked === "strategic" && role !== "admin") throw new ScopeError(STRATEGIC_MESSAGE, "role_not_permitted");
  if (asked === "routine") {
    if (kind !== "change_request") {
      throw new FieldsError("Validation failed", [{ field: "tier", message: "Only a change request can be routine." }]);
    }
    if (cost !== 0 || days !== 0 || (input.impact_scope_count ?? 0) > 0) {
      throw new FieldsError("Validation failed", [
        { field: "tier", message: "A routine change cannot carry a cost, a schedule impact or a scope impact. Raise it as normal." },
      ]);
    }
  }

  const floor: Tier = kind === "project_deletion" ? "high_risk" : "normal";
  let tier: Tier = asked ?? floor;
  // Routine (validated above: a change request with no money and no dates) is the one tier below the floor.
  if (asked !== "routine" && TIER_RANK[tier] < TIER_RANK[floor]) tier = floor;

  let reason: string | null = tier !== "normal" && tier === floor && !asked ? "Deleting a whole project is high risk." : null;
  let bump = false;
  if (kind === "expense_deletion" && tier === "normal") {
    const amount = Math.abs(Number(input.amount ?? 0) || 0);
    if (amount !== 0 && amount >= policy.currency_threshold) {
      tier = "high_risk";
      bump = true;
      reason = `Deleting an expense of ${policy.currency_threshold.toLocaleString("en-US")} or more is high risk.`;
    }
  }
  if (kind === "change_request" && tier === "normal") {
    const overCost = cost !== 0 && Math.abs(cost) >= policy.currency_threshold;
    const overDays = Math.abs(days) > policy.schedule_threshold_days;
    if (overCost || overDays) {
      tier = "high_risk";
      bump = true;
      reason = overCost
        ? `The cost reaches the ${policy.currency_threshold.toLocaleString("en-US")} threshold.`
        : `The schedule impact is more than ${policy.schedule_threshold_days} days.`;
    }
  }
  return { tier, reason, threshold_bump: bump };
}

/** The tier a change request moves to when its cost or schedule is edited (never down). */
export function reclassifyOnEdit(
  current: Tier,
  edit: { impact_cost?: number | null; impact_schedule_days?: number | null; impact_scope_count?: number; policy: ApprovalPolicy },
): Tier {
  if (current === "emergency" || current === "high_risk" || current === "strategic") return current;
  const cost = Number(edit.impact_cost ?? 0) || 0;
  const days = Number(edit.impact_schedule_days ?? 0) || 0;
  let tier: Tier = current;
  if (tier === "routine" && (cost !== 0 || days !== 0 || (edit.impact_scope_count ?? 0) > 0)) tier = "normal";
  if (tier === "normal") {
    if ((cost !== 0 && Math.abs(cost) >= edit.policy.currency_threshold) || Math.abs(days) > edit.policy.schedule_threshold_days) {
      tier = "high_risk";
    }
  }
  return tier;
}

// ── routing (G2) ──────────────────────────────────────────────────────────

/** The role the policy asks of whoever decides this tier (an emergency is never decided; its role is unused). */
export function approverRoleFor(tier: Tier | string | null | undefined, policy: ApprovalPolicy): TierApproverRole {
  return policy.tiers[isTier(tier) ? tier : "normal"].approver_role;
}

/** True when `role` may decide `tier`: an admin may decide any tier, a manager those that ask for a manager. */
export function roleMeetsTier(role: string | null | undefined, tier: Tier | string | null | undefined, policy: ApprovalPolicy): boolean {
  if (role === "admin") return true;
  return role === "manager" && approverRoleFor(tier, policy) === "manager";
}

/** Profile roles that should be told about / may decide a tier: admins always, managers when the tier allows. */
export function eligibleRoles(tier: Tier | string | null | undefined, policy: ApprovalPolicy): ("admin" | "manager")[] {
  return approverRoleFor(tier, policy) === "admin" ? ["admin"] : ["admin", "manager"];
}

const TIER_WORDS: Record<string, string> = { high_risk: "a high-risk", routine: "a routine", normal: "a normal", emergency: "an emergency", strategic: "a strategic" };

/** "Only admins can approve a high-risk request." for an admin-level tier. */
export const tierRoleMessage = (role: TierApproverRole, tier?: string | null) =>
  role === "admin"
    ? `Only admins can approve ${TIER_WORDS[tier ?? ""] ?? "this"} request.`
    : "Only managers and admins can approve";

type RoleActor = { type: string; role?: string | null; principalRole?: string | null };

/** The role of the HUMAN behind an actor (a token judged by its creator's role). */
export function humanRoleOf(actor: RoleActor): string | null {
  return actor.type === "user" ? (actor.role ?? null) : (actor.principalRole ?? null);
}

/**
 * 403 `role_not_permitted` when the actor's human does not meet the tier (the route-level twin of the
 * DB trigger). Fallback approver (owner decision D7): when the workspace has fewer than two admins
 * (`singleAdmin`), a MANAGER may decide an admin-tier request; that case returns `true` so the
 * caller can record `fallback_approver`. Otherwise returns `false`.
 */
export function requireTierRole(
  actor: RoleActor,
  tier: Tier | string | null | undefined,
  policy: ApprovalPolicy,
  opts: { singleAdmin?: boolean } = {},
): boolean {
  const role = humanRoleOf(actor);
  if (roleMeetsTier(role, tier, policy)) return false;
  if (role === "manager" && opts.singleAdmin === true) return true;
  throw new ScopeError(tierRoleMessage(approverRoleFor(tier, policy), isTier(tier) ? tier : null), "role_not_permitted");
}

/** True when the workspace has fewer than two admins, so no second admin exists for an admin-tier request. Fail-closed (false) on error. */
export async function hasFewerThanTwoAdmins(db: Db, workspaceId: string): Promise<boolean> {
  try {
    const { data, error } = await db.from("profiles").select("id").eq("workspace_id", workspaceId).eq("role", "admin").limit(2);
    if (error || !data) return false;
    return (data as unknown[]).length < 2;
  } catch {
    return false;
  }
}

/**
 * The decision-time tier check every decide path uses: loads the policy and, only when the plain rule
 * would refuse a manager, whether the D7 fallback applies. Returns true when the fallback was used.
 */
export async function assertTierRole(db: Db, actor: RoleActor & { workspaceId: string }, tier: Tier | string | null | undefined): Promise<boolean> {
  const policy = await loadApprovalPolicy(db, actor.workspaceId);
  const plain = roleMeetsTier(humanRoleOf(actor), tier, policy);
  if (plain) return false;
  const singleAdmin = humanRoleOf(actor) === "manager" ? await hasFewerThanTwoAdmins(db, actor.workspaceId) : false;
  return requireTierRole(actor, tier, policy, { singleAdmin });
}

// ── timers (G3, G4) ───────────────────────────────────────────────────────

/** When a decision on this tier is due, or null when the tier has no turnaround. */
export function deadlineFor(tier: Tier | string | null | undefined, policy: ApprovalPolicy, now: Date): Date | null {
  const t = isTier(tier) ? tier : "normal";
  if (t === "emergency") return null; // an emergency commits when raised: nothing waits
  const hours = policy.tiers[t].turnaround_hours;
  return hours > 0 ? new Date(now.getTime() + hours * 3_600_000) : null;
}

/** Half of the turnaround has passed (the reminder point), from the raise time and the deadline. */
export function reminderDueAt(raisedAt: string | Date, deadline: string | Date): Date {
  const a = new Date(raisedAt).getTime();
  const b = new Date(deadline).getTime();
  return new Date(a + (b - a) / 2);
}
