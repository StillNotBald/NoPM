import { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/auth/guard";
import { ApiError, NotFoundError, PreconditionFailedError } from "@/lib/api/errors";
import { auditPrincipalId, buildAuditRow } from "@/lib/audit/row";

/**
 * Atomic audited writes (audit M1, owner answer Q-GOV-23 "all-or-nothing").
 *
 * A mutation and its audit row are written by ONE database function
 * (nopm_mutate_audited, migration 0103) inside one transaction. If either
 * fails, neither is kept, so a change the trail never saw cannot exist.
 * Fail-closed: when the RPC errors, nothing was written and the error is
 * thrown to the caller.
 *
 * The audit payload is built with the same buildAuditRow() that writeAudit()
 * uses (same actor, channel, request id, connector provenance, principal), so
 * rows look identical to the ones the old mutate-then-audit handlers wrote.
 * `before` and `after` are the real rows read and written inside the
 * transaction, so a handler no longer fetches them for the audit row.
 */

/** The tables nopm_mutate_audited accepts. Mirrors the allowlist in migration 0103 (a test checks both). */
export const AUDITED_TABLES = [
  "projects",
  "milestones",
  "tasks",
  "risks",
  "issues",
  "clashes",
  "programs",
  "sprints",
  "allocations",
  "expenses",
  "resource_members",
  "saved_views",
  "calendar_feeds",
  "documents",
  "decisions",
  "invites",
  "api_tokens",
  "notifications",
  "integration_connectors",
  "external_identities",
  "assistant_credentials",
  "project_budget",
  "profiles",
  "project_dependencies",
  "task_dependencies",
] as const;
export type AuditedTable = (typeof AUDITED_TABLES)[number];

export type AuditedRow = Record<string, unknown>;

type Common = {
  table: AuditedTable;
  actor: Actor;
  /** Defaults to actor.workspaceId. */
  workspaceId?: string;
  /** Glossary action, e.g. "task.update". */
  action: string;
  /** Audit target_type; defaults to the table name in the singular. */
  targetType?: string;
  /** Message of the 404 when the row is not in the workspace. */
  notFoundMessage?: string;
  /** Extra keys merged into the audited "after" only (not the stored row, not the returned row). */
  afterExtra?: Record<string, unknown>;
  /**
   * For an audit event that is not "this row changed" (a sprint started, a task attached to a
   * sprint): replace what the audit row records. Omit to record the real before / after rows;
   * pass null to record SQL null. The stored row and the returned rows are unaffected.
   */
  auditBefore?: unknown;
  auditAfter?: unknown;
  /** Audit target id when it is not the written row (e.g. the sprint a task was attached to). */
  auditTargetId?: string;
  /**
   * Secret-bearing columns (a token hash, an encrypted key) to keep out of the audit row and out of
   * the rows this call returns. The column is still written; it is just never read back.
   */
  omitColumns?: readonly string[];
  /** Compare-and-set: the row must still have this nullable column NULL (e.g. "revoked_at"), else 412. */
  requireNull?: string;
};

type AuditOverrides = Pick<Common, "afterExtra" | "auditBefore" | "auditAfter" | "auditTargetId" | "omitColumns" | "requireNull">;

export type AuditedInsert = Common & {
  patch: Record<string, unknown>;
  /** Optional client-chosen id; otherwise the column default applies. */
  id?: string;
};
export type AuditedUpdate = Common & {
  id: string;
  patch: Record<string, unknown>;
  /** Optimistic concurrency: the updated_at the caller read. Mismatch -> 412. */
  expectedUpdatedAt?: string | null;
};
export type AuditedDelete = Common & {
  id: string;
  expectedUpdatedAt?: string | null;
};

export type AuditedResult = { before: AuditedRow | null; after: AuditedRow | null };

/** Singular audit target_type per table, written out so no plural rule can get one wrong. */
const TARGET_TYPES: Record<AuditedTable, string> = {
  projects: "project",
  milestones: "milestone",
  tasks: "task",
  risks: "risk",
  issues: "issue",
  clashes: "clash",
  programs: "program",
  sprints: "sprint",
  allocations: "allocation",
  expenses: "expense",
  resource_members: "resource_member",
  saved_views: "saved_view",
  calendar_feeds: "calendar_feed",
  documents: "document",
  decisions: "decision",
  invites: "invite",
  api_tokens: "api_token",
  notifications: "notification",
  integration_connectors: "integration_connector",
  external_identities: "external_identity",
  assistant_credentials: "assistant_credential",
  project_budget: "project_budget",
  profiles: "profile",
  project_dependencies: "project_dependency",
  task_dependencies: "task_dependency",
};

export function targetTypeFor(table: AuditedTable): string {
  return TARGET_TYPES[table];
}

type PgError = { message?: string; code?: string } | null;

/** Map an RPC failure to the repo's error classes; anything else is rethrown untouched so SQLSTATE handling in callers (23505 ...) keeps working. */
export function mapAuditedError(error: NonNullable<PgError>, notFoundMessage = "Not found"): never {
  const message = typeof error.message === "string" ? error.message : "";
  if (/^NOT_FOUND\b/.test(message)) throw new NotFoundError(notFoundMessage);
  if (/^STALE_ROW\b/.test(message)) throw new PreconditionFailedError("Record changed since you loaded it");
  if (/^(UNKNOWN_COLUMN|FORBIDDEN_COLUMN|TABLE_NOT_ALLOWED|INVALID_OP|INVALID_CHANNEL|NO_UPDATED_AT)\b/.test(message)) {
    // A programming error, never the caller's fault: log the detail, return a generic 500.
    console.error("[nopm] audited write rejected:", message);
    throw new ApiError(500, "Internal server error", "audited_write_rejected");
  }
  throw error;
}

/** The p_audit argument: the writeAudit row minus what the RPC derives itself (before / after / target id). */
export function buildAuditArg(
  actor: Actor,
  workspaceId: string,
  action: string,
  targetType: string,
  overrides: AuditOverrides = {},
): Record<string, unknown> {
  const row = buildAuditRow({ workspaceId, actor, action, targetType });
  const principalId = auditPrincipalId(actor);
  return {
    action: row.action,
    target_type: row.target_type,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    actor_label: row.actor_label,
    channel: row.channel ?? null,
    request_id: row.request_id ?? null,
    principal_id: principalId,
    via_connector_id: row.via_connector_id ?? null,
    external_event_id: row.external_event_id ?? null,
    external_actor_ref: row.external_actor_ref ?? null,
    ...(overrides.afterExtra ? { after_extra: overrides.afterExtra } : {}),
    ...(overrides.auditBefore !== undefined ? { before: overrides.auditBefore } : {}),
    ...(overrides.auditAfter !== undefined ? { after: overrides.auditAfter } : {}),
    ...(overrides.auditTargetId ? { target_id: overrides.auditTargetId } : {}),
    ...(overrides.requireNull ? { require_null: overrides.requireNull } : {}),
    ...(overrides.omitColumns?.length ? { omit_columns: [...overrides.omitColumns] } : {}),
  };
}

async function run(
  op: "insert" | "update" | "delete",
  c: Common,
  id: string | null,
  patch: Record<string, unknown>,
  expectedUpdatedAt: string | null | undefined,
): Promise<AuditedResult> {
  const workspaceId = c.workspaceId ?? c.actor.workspaceId;
  const { data, error } = await createAdminClient().rpc("nopm_mutate_audited", {
    p_table: c.table,
    p_op: op,
    p_workspace_id: workspaceId,
    p_id: id,
    p_patch: patch,
    p_expected_updated_at: expectedUpdatedAt ?? null,
    p_audit: buildAuditArg(c.actor, workspaceId, c.action, c.targetType ?? targetTypeFor(c.table), c),
  });
  if (error) mapAuditedError(error, c.notFoundMessage);
  const result = (data ?? {}) as { before?: AuditedRow | null; after?: AuditedRow | null };
  return { before: result.before ?? null, after: result.after ?? null };
}

/** Insert one row and its audit row atomically. Returns the inserted row. */
export async function auditedInsert(input: AuditedInsert): Promise<AuditedRow> {
  const { after } = await run("insert", input, input.id ?? null, input.patch, null);
  if (!after) throw new Error("Insert returned no row");
  return after;
}

/** Update one row of the workspace and write its audit row atomically. Returns before and after. */
export async function auditedUpdate(input: AuditedUpdate): Promise<{ before: AuditedRow; after: AuditedRow }> {
  const { before, after } = await run("update", input, input.id, input.patch, input.expectedUpdatedAt);
  if (!before || !after) throw new Error("Update returned no row");
  return { before, after };
}

/** Delete one row of the workspace and write its audit row atomically. Returns the deleted row. */
export async function auditedDelete(input: AuditedDelete): Promise<AuditedRow> {
  const { before } = await run("delete", input, input.id, {}, input.expectedUpdatedAt);
  if (!before) throw new Error("Delete returned no row");
  return before;
}
