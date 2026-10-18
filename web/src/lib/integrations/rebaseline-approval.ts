import { requireScope, type Actor } from "@/lib/auth/guard";
import { requireApprover } from "@/lib/auth/approver";
import { createAdminClient } from "@/lib/supabase/admin";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import {
  actorLabel,
  announceDecided,
  assertNotRequesterPrincipal,
  projectNameOf,
  requirePrincipal,
  type DecisionResult,
} from "@/lib/governance/decide";
import { assertSignoffOpen } from "@/lib/governance/rebaseline-lifecycle";
import { auditRpcArgs, throwRebaselineRpcError } from "@/lib/governance/rebaseline-rpc";
import type { ApprovalEvent } from "@/lib/integrations/types";

/**
 * Rebaseline sign-off as a Lark approval kind (Q-GOV-19 / Q-ACC-17, 2026-10-17).
 *
 * Two things live here so the integration hub can treat a rebaseline like any
 * other governed request WITHOUT touching lib/governance:
 *
 *  - `rebaselineEvent`: the ApprovalEvent for a rebaseline waiting for sign-off.
 *    The propose route calls `announceRequested(await rebaselineEvent(...))`
 *    when it creates a `pending_approval` row, exactly as the change-request
 *    route does.
 *  - `signoffRebaseline`: the same sequence the POST /api/rebaselines/[id]/signoff
 *    route runs (scope, approver role, principal, four-eyes, lifecycle guard,
 *    then the atomic `nopm_signoff_rebaseline` RPC that writes the vote, the
 *    status and the single audit row), built only from lib/governance exports.
 *    A card's Approve is the vote "go"; Reject is "no_go".
 */

type Db = ReturnType<typeof createAdminClient>;

export type RebaselineRow = {
  id: string;
  project_id: string;
  version?: number | null;
  status: string;
  reason?: string | null;
  requested_by?: string | null;
  requested_principal_id?: string | null;
  after?: unknown;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** "New dates: 2026-11-01 to 2026-12-15" when the proposal carries them. */
function describeDates(after: unknown): string {
  if (!after || typeof after !== "object" || Array.isArray(after)) return "";
  const a = after as Record<string, unknown>;
  const start = str(a.start_date) || str(a.startDate) || str(a.start);
  const end = str(a.end_date) || str(a.endDate) || str(a.end) || str(a.target_date);
  if (start && end) return `New dates: ${start} to ${end}`;
  if (end) return `New end date: ${end}`;
  if (start) return `New start date: ${start}`;
  return "";
}

async function requesterLabel(db: Db, workspaceId: string, row: RebaselineRow): Promise<string> {
  const id = row.requested_principal_id ?? row.requested_by ?? null;
  if (!id) return "unknown";
  try {
    const { data } = await db
      .from("profiles")
      .select("display_name, email")
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    const p = data as { display_name?: string | null; email?: string | null } | null;
    return p?.display_name || p?.email || "unknown";
  } catch {
    return "unknown";
  }
}

export async function rebaselineEvent(db: Db, workspaceId: string, row: RebaselineRow): Promise<ApprovalEvent> {
  const projectName = await projectNameOf(db, workspaceId, row.project_id);
  const dates = describeDates(row.after);
  const summary = [row.reason?.trim(), dates].filter(Boolean).join(" - ") || null;
  return {
    workspaceId,
    kind: "rebaseline_signoff",
    id: row.id,
    title: `Rebaseline${row.version ? ` v${row.version}` : ""}${projectName ? `: ${projectName}` : ""}`,
    summary,
    projectId: row.project_id,
    projectName,
    requestedByLabel: await requesterLabel(db, workspaceId, row),
    requesterPrincipalId: row.requested_principal_id ?? row.requested_by ?? null,
  };
}

/**
 * Cast the sign-off vote as `actor` and announce the result. Throws the same
 * ApiErrors the REST route throws (403 self_approval / no_principal /
 * role_not_permitted, 422 rebaseline_not_pending, 404).
 */
export async function signoffRebaseline(
  actor: Actor,
  id: string,
  vote: "go" | "no_go",
  comment?: string | null,
): Promise<DecisionResult> {
  requireScope(actor, "rebaseline:approve");
  if (vote === "no_go" && !comment?.trim()) {
    throw new RuleError("Please give a reason for rejecting.", "rationale_required");
  }
  if (vote === "no_go" && !comment?.trim()) {
    throw new RuleError("Please give a reason for rejecting.", "rationale_required");
  }
  const principal = requirePrincipal(actor);
  requireApprover(actor);

  const db = createAdminClient();
  const { data, error: fetchError } = await db
    .from("rebaselines")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!data) throw new NotFoundError("Rebaseline not found");
  const row = data as RebaselineRow;

  if (actor.type === "user" && row.requested_by && actor.id === row.requested_by) {
    throw new RuleError("Four-eyes: you cannot sign off a rebaseline you requested.", "self_approval");
  }
  assertNotRequesterPrincipal(
    row.requested_principal_id,
    principal,
    "Four-eyes: you cannot sign off a rebaseline you requested.",
  );
  assertSignoffOpen(row.status);

  const { data: rpc, error } = await db.rpc("nopm_signoff_rebaseline", {
    p_rebaseline_id: id,
    p_workspace_id: actor.workspaceId,
    p_vote: vote,
    p_comment: comment?.trim() || null,
    p_approver_principal_id: principal,
    ...auditRpcArgs(actor),
  });
  if (error) throwRebaselineRpcError(error, "Failed to record the sign-off");

  const after = (rpc as { rebaseline?: Record<string, unknown> } | null)?.rebaseline ?? {};
  const status = str(after.status) || (vote === "go" ? "approved" : "rejected");
  const ev = await rebaselineEvent(db, actor.workspaceId, { ...row, status });
  // Only a settled rebaseline retires its cards; a vote that leaves it pending is not a decision to announce.
  if (status !== "pending_approval") {
    announceDecided({
      ...ev,
      status,
      decidedByLabel: actorLabel(actor),
      channel: actor.channel ?? (actor.type === "token" ? "api" : "ui"),
    });
  }
  return { kind: "rebaseline_signoff", id, status, title: ev.title, requesterPrincipalId: ev.requesterPrincipalId };
}
