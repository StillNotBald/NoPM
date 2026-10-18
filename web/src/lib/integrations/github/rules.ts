/**
 * Work-event status rules (R-153). A workspace maps each GitHub work event to the status a linked
 * task moves to, or to nothing. The same value set is enforced in the database by
 * `nopm_valid_work_event_rules` (migration 0105); this file is the application-side twin.
 */

export const WORK_EVENT_KINDS = ["pr_opened", "pr_merged", "pr_closed", "deploy_success", "deploy_failure"] as const;
export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number];

/** A status a work event may move a task to. `in_review` is status_type started with the label "In review". */
export const RULE_TARGETS = ["unstarted", "started", "in_review", "completed", "canceled"] as const;
export type RuleTarget = (typeof RULE_TARGETS)[number];

export type WorkEventRules = Record<WorkEventKind, RuleTarget | null>;

export const DEFAULT_RULES: WorkEventRules = {
  pr_opened: "started",
  pr_merged: "in_review",
  pr_closed: null,
  deploy_success: "completed",
  deploy_failure: null,
};

export const RULE_TARGET_LABELS: Record<RuleTarget, string> = {
  unstarted: "Not started",
  started: "In progress",
  in_review: "In review",
  completed: "Completed",
  canceled: "Canceled",
};

export const IN_REVIEW_LABEL = "In review";

export type TaskStatusType = "backlog" | "unstarted" | "started" | "completed" | "canceled";

/** The label the board shows for each status type when nobody typed one (tasks.status is NOT NULL, default "Backlog"). */
export const DEFAULT_STATUS_LABELS: Record<TaskStatusType, string> = {
  backlog: "Backlog",
  unstarted: "To do",
  started: "In progress",
  completed: "Done",
  canceled: "Canceled",
};

const SYSTEM_LABELS = new Set([...Object.values(DEFAULT_STATUS_LABELS), IN_REVIEW_LABEL].map((l) => l.toLowerCase()));

/** True for a label the system itself uses (or an empty one); a label a person typed is custom and is kept. */
export function isSystemLabel(label: string | null | undefined): boolean {
  return !label || SYSTEM_LABELS.has(label.trim().toLowerCase());
}

/**
 * The label a work-event move should write: "In review" for the review target, otherwise the default
 * label of the new type, but only when the task's current label is a system label. undefined = keep
 * the current label (a custom one). Never null: tasks.status cannot be NULL.
 */
export function labelForMove(target: RuleTarget, statusType: TaskStatusType, currentLabel: string | null | undefined): string | undefined {
  if (target === "in_review") return IN_REVIEW_LABEL;
  return isSystemLabel(currentLabel) ? DEFAULT_STATUS_LABELS[statusType] : undefined;
}

/** What a rule target means on the task row. */
export function targetToStatus(target: RuleTarget): { statusType: TaskStatusType; label: string | null } {
  if (target === "in_review") return { statusType: "started", label: IN_REVIEW_LABEL };
  return { statusType: target, label: null };
}

/** Parse a stored value into rules; unknown keys and values fall back to the defaults. */
export function normalizeRules(raw: unknown): WorkEventRules {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_RULES };
  for (const kind of WORK_EVENT_KINDS) {
    if (!(kind in src)) continue;
    const v = src[kind];
    if (v === null) out[kind] = null;
    else if (typeof v === "string" && (RULE_TARGETS as readonly string[]).includes(v)) out[kind] = v as RuleTarget;
  }
  return out;
}

/** Strict check for a PATCH body: returns the problem, not a silently repaired value. */
export function validateRulesPatch(
  raw: unknown,
): { ok: true; rules: Partial<WorkEventRules> } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "rules must be an object" };
  const out: Partial<WorkEventRules> = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(WORK_EVENT_KINDS as readonly string[]).includes(key)) return { ok: false, message: `Unknown work event "${key}"` };
    if (v === null) out[key as WorkEventKind] = null;
    else if (typeof v === "string" && (RULE_TARGETS as readonly string[]).includes(v)) out[key as WorkEventKind] = v as RuleTarget;
    else return { ok: false, message: `rules.${key} must be one of ${RULE_TARGETS.join(", ")} or null` };
  }
  if (Object.keys(out).length === 0) return { ok: false, message: "rules must name at least one work event" };
  return { ok: true, rules: out };
}

/** Forward-only ordering: an event never drags a task backwards or reopens a closed one. Canceled is -1 (never touched). */
export function statusRank(statusType: string | null | undefined, label: string | null | undefined): number {
  switch (statusType) {
    case "backlog":
      return 0;
    case "unstarted":
      return 1;
    case "started":
      return label === IN_REVIEW_LABEL ? 3 : 2;
    case "completed":
      return 4;
    default:
      return -1;
  }
}

export function targetRank(target: RuleTarget): number {
  const { statusType, label } = targetToStatus(target);
  return statusRank(statusType, label);
}
